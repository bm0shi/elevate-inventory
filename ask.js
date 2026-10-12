// ============================================================
// ASK ELEVATE — the owner asks a question in plain words ("how much profit
// is the tea tree liter shampoo?") and Claude answers from the app's own
// data. Opened from the ⌘K box (palette.js) once Admin is unlocked.
//
// Claude gets read-only tools: find a product, Product Profit for a date
// range, the monthly P&L (both through the app's own finance routes, so the
// numbers match the screens), and a SELECT-only database query for the rest.
// Owner only (money). Needs ANTHROPIC_API_KEY in Railway; without it the
// route says so instead of failing.
//
// Mounted from server.js: require('./ask')(app, deps).
// Testing without a key: ANTHROPIC_BASE_URL can point at a fake (never in Railway).
// ============================================================
const Anthropic = require('@anthropic-ai/sdk');
const { betaTool } = require('@anthropic-ai/sdk/helpers/beta/json-schema');
const askSql = require('./lib/ask-sql');
const search = require('./lib/search');

const MODEL = 'claude-opus-5-5';
// $ per million tokens (Claude Opus 5.5), for the small cost note under each answer
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

// What the tables mean, in the business's words. The column list itself is
// read from the database at runtime so it never goes stale.
const NOTES = `
Key tables (Postgres):
- inv_products: the catalog. asin is the key. name is Amazon's full title and includes the size (e.g. "33.8 fl. oz." = liter, "16.9 fl. oz.", "5.1 fl. oz."). sku = our Amazon seller SKU. avg_cost = our blended cost per unit from Cosmoprof invoices. location = rack spot.
- inv_bundles: duos. bundle_asin (the duo listing) = component_asin bottles (qty each).
- inv_stock: units on our warehouse shelf (onhand) and on the way to Amazon (transit), by asin (bottles).
- inv_pending_prep / inv_prepped: units waiting to be prepped / prepped and ready to ship (prepped is stored as scanned: duo listings under the duo asin).
- inv_shipments + inv_shipment_items: FBA shipments we sent (items are bottles; shipped_as = the listing they went out as). qty_received = what Amazon counted.
- inv_fba_daily: units at Amazon per asin per day (onhand, fulfillable, inbound).
- inv_sales_daily: gross sales per Pacific day for the whole account (units, sales $, orders). est = part of sales priced from pending orders.
- inv_settlement_lines: Amazon settlement money lines (posted_date, sku, asin, amount_type ItemPrice/ItemFees/Promotion..., amount_description Principal/Commission/FBAPerUnitFulfillmentFee..., amount, quantity). Settlements lag up to two weeks.
- inv_fin_daily: refunds and Amazon fees per day from financial events (on time).
- inv_returns: customer returns. inv_refund_orders: refunds per order. inv_reimbursements: what Amazon reimbursed.
- inv_invoices / inv_invoice_items: Cosmoprof purchase invoices (unit_cost, qty_expected, qty_received). inv_cost_history: cost per unit by invoice.
- inv_prep_log: prep jobs (qty units, duration_sec, worker, crew). inv_timecards: hours and wages.
- fin_overhead: monthly overhead lines. fin_cash: cash snapshots.
Prefer the product_profit and monthly_pnl tools for any profit question: they apply the app's rules (matched cost of goods, Amazon fees, refunds, supplies, labor by prep time, inbound freight), so the answer matches the Product Profit and P&L screens.`;

const SYSTEM_HEAD = `You are Elevate, the analyst inside Elevate Inventory, an Amazon FBA business that buys professional hair care (mostly Paul Mitchell / Tea Tree) from Cosmoprof, preps it in a warehouse in Arizona, and sells it on Amazon. The owner asks you questions about the business; answer from the data using the tools.

How to answer:
- Look the numbers up; never guess or invent a figure. If the data can't answer it, say what's missing and where in the app to fill it in.
- Products come in several sizes. When a question names a product, use find_products to resolve the exact listing(s); if the size is ambiguous, answer for each size (they're different products), naming the size every time.
- Say which period a number covers. If no period is given, use the last 30 days and say so. Settlement-based profit lags up to two weeks: mention it when the period is recent.
- Lead with the answer in one sentence, then the few supporting numbers. Short. Plain words, no jargon. Use a small markdown table only when comparing several items. Money as $1,234.
- Today's date and time are given at the start of each question.`;

module.exports = function registerAsk(app, deps) {
  const { pool, ownerAuth, port } = deps;
  let schemaText = null, schemaAt = 0;

  async function schema() {
    if (schemaText && Date.now() - schemaAt < 3600e3) return schemaText;
    const r = await pool.query(`SELECT table_name, string_agg(column_name || ' ' || data_type, ', ' ORDER BY ordinal_position) AS cols
      FROM information_schema.columns WHERE table_schema = 'public'
        AND (table_name LIKE 'inv\\_%' OR table_name LIKE 'fin\\_%')
        AND table_name NOT IN ('inv_idempotency', 'inv_undo', 'inv_cache', 'fin_snapshots', 'inv_ss_uploads')
      GROUP BY table_name ORDER BY table_name`);
    schemaText = r.rows.map(x => `${x.table_name}(${x.cols.replace(/character varying|text/g, 'text').replace(/timestamp with time zone/g, 'timestamptz')})`).join('\n');
    schemaAt = Date.now();
    return schemaText;
  }

  // The app's own finance routes, so Ask Elevate and the screens agree.
  async function selfGet(path) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'x-app-password': process.env.APP_PASSWORD || '', 'x-owner-password': process.env.OWNER_PASSWORD || '' },
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || d.error) throw new Error((d && d.error) || `HTTP ${r.status}`);
    return d;
  }

  const r2 = v => (v == null ? null : Math.round(v * 100) / 100);

  function tools(step) {
    return [
      betaTool({
        name: 'find_products',
        description: 'Find catalog listings by words in the name, or by ASIN/SKU/FNSKU. Returns asin, sku, full name (with size), units on our shelf and our unit cost. Use it to resolve a product the owner names before looking up its numbers.',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "tea tree special shampoo liter" or an ASIN' } }, required: ['query'], additionalProperties: false },
        run: async ({ query }) => {
          step('Finding “' + String(query).slice(0, 60) + '”…');
          const look = async q => {
            const t = search.terms(q), words = t.words.length ? t.words : [t.any];
            return { t, rows: (await pool.query(`SELECT p.asin, p.sku, p.fnsku, p.name, p.avg_cost, p.upc_norm, COALESCE(s.onhand,0)::int AS onhand
              FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
              WHERE upper(p.asin) = $1 OR upper(p.sku) = $1 OR upper(p.fnsku) = $1 OR p.name ILIKE ALL($2::text[])
              LIMIT 80`, [t.upper, words])).rows };
          };
          let { t, rows } = await look(query);
          // "liter" or "33.8 oz" isn't always how the title says it: try again without the size words
          if (!rows.length) {
            const bare = String(query).replace(/\b(liters?|litres?|oz|ounces?|fl|ml|gallon|\d+(\.\d+)?)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();
            if (bare && bare !== query) ({ t, rows } = await look(bare));
          }
          const ranked = rows.map(p => ({ p, r: search.rankProduct(p, t.raw) })).filter(x => x.r > 0)
            .sort((a, b) => b.r - a.r).slice(0, 15).map(({ p }) => ({ asin: p.asin, sku: p.sku, name: p.name, onhand: p.onhand, unit_cost: r2(Number(p.avg_cost)) }));
          return ranked.length ? JSON.stringify(ranked) : 'No listing matches. Try fewer words, or run_sql on inv_products.name.';
        },
      }),
      betaTool({
        name: 'product_profit',
        description: 'Profit per product for a date range, from Amazon settlements: units sold, net sales, Amazon fees, landed cost per unit (product cost + supplies + labor + inbound freight), profit, profit per unit, margin %, and anything missing from the cost. Same numbers as Admin → Product Profit. Settlements lag up to 2 weeks.',
        inputSchema: { type: 'object', properties: {
          from: { type: 'string', description: 'YYYY-MM-DD, inclusive' }, to: { type: 'string', description: 'YYYY-MM-DD, exclusive' },
          asins: { type: 'array', items: { type: 'string' }, description: 'Only these listings (from find_products). Omit for every product.' },
        }, required: ['from', 'to'], additionalProperties: false },
        run: async ({ from, to, asins }) => {
          step('Reading product profit ' + from + ' to ' + to + '…');
          const d = await selfGet(`/api/finance/products?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
          let items = d.items || [];
          if (asins && asins.length) { const want = new Set(asins.map(a => String(a).toUpperCase())); items = items.filter(x => x.asin && want.has(x.asin.toUpperCase())); }
          const rows = items.map(x => ({ asin: x.asin, sku: x.sku, name: x.name, units_sold: x.netUnits, returned: x.unitsRefunded, net_sales: r2(x.netSales),
            amazon_fees: r2(x.fees), fees_per_unit: r2(x.feesPerUnit), landed_cost_per_unit: r2(x.landedPerUnit), unit_cost: r2(x.unitCost),
            labor_per_unit: r2(x.laborPerUnit), freight_per_unit: r2(x.freightPerUnit), supplies_per_unit: r2(x.suppliesPerUnit),
            profit: r2(x.profit), profit_per_unit: r2(x.profitPerUnit), margin_pct: r2(x.marginPct), not_in_cost_yet: x.missing }));
          if (!rows.length) return asins && asins.length ? 'No settled sales for those listings in this range (settlements lag up to 2 weeks; try a longer or earlier range).' : 'No settled sales in this range.';
          rows.sort((a, b) => (b.profit || 0) - (a.profit || 0));
          return askSql.rowsText(rows, 24000);
        },
      }),
      betaTool({
        name: 'monthly_pnl',
        description: 'The monthly profit & loss for the last N months (sales, refunds, Amazon fees, cost of goods, labor, overhead, net). Same as Admin → P&L.',
        inputSchema: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['months'], additionalProperties: false },
        run: async ({ months }) => {
          step('Reading the P&L…');
          const d = await selfGet(`/api/finance/pnl?months=${Math.max(1, Math.min(24, months | 0))}`);
          return JSON.stringify(d.months || []).slice(0, 24000);
        },
      }),
      betaTool({
        name: 'run_sql',
        description: 'Run ONE read-only Postgres SELECT on the app database (schema in the system prompt). Returns up to 200 rows as JSON lines. Use for sales, stock, shipments, refunds, returns, prep speed, purchases and anything the other tools do not cover.',
        inputSchema: { type: 'object', properties: { sql: { type: 'string' }, purpose: { type: 'string', description: 'A few words on what this looks up' } }, required: ['sql'], additionalProperties: false },
        run: async ({ sql, purpose }) => {
          const c = askSql.checkSql(sql);
          if (!c.ok) return 'Not run: ' + c.error;
          step(purpose ? String(purpose).slice(0, 80) + '…' : 'Looking it up…');
          const db = await pool.connect();
          try {
            await db.query('BEGIN TRANSACTION READ ONLY');
            await db.query("SET LOCAL statement_timeout = '8s'");
            const r = await db.query(askSql.wrapLimit(c.sql, 201));
            await db.query('ROLLBACK');
            if (!r.rows.length) return 'No rows.';
            return (r.rows.length > 200 ? 'First 200 rows:\n' : '') + askSql.rowsText(r.rows.slice(0, 200));
          } catch (e) {
            await db.query('ROLLBACK').catch(() => {});
            return 'Query error: ' + e.message;
          } finally { db.release(); }
        },
      }),
    ];
  }

  // POST /api/ask {question, history:[{q,a}]} → NDJSON lines: {step}, then {answer} or {error}
  app.post('/api/ask', ownerAuth, async (req, res) => {
    const question = String((req.body && req.body.question) || '').trim().slice(0, 2000);
    if (!question) return res.status(400).json({ ok: false, error: 'Ask a question.' });
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
      return res.json({ ok: false, error: 'Ask Elevate needs an Anthropic API key: add ANTHROPIC_API_KEY in Railway (Variables), then ask again.' });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const send = o => { try { res.write(JSON.stringify(o) + '\n'); } catch (e) {} };
    const step = text => send({ step: text });
    try {
      const history = Array.isArray(req.body.history) ? req.body.history.slice(-6) : [];
      const messages = [];
      for (const h of history) {
        if (!h || !h.q || !h.a) continue;
        messages.push({ role: 'user', content: String(h.q).slice(0, 2000) }, { role: 'assistant', content: String(h.a).slice(0, 6000) });
      }
      const now = new Date();
      const az = new Date(now.getTime() - 7 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
      messages.push({ role: 'user', content: `(Today is ${az} Arizona time.)\n\n${question}` });
      const client = new Anthropic.default ? new Anthropic.default() : new Anthropic();
      step('Thinking…');
      const params = {
        model: MODEL,
        max_tokens: 16000,
        max_iterations: 12,
        output_config: { effort: 'medium' },
        // a declined request is retried on another model inside the same call
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM_HEAD + '\n' + NOTES + '\n\nTables and columns:\n' + await schema(), cache_control: { type: 'ephemeral' } }],
        tools: tools(step),
        messages,
      };
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let last = null;
      const run = async p => {
        for await (const msg of client.beta.messages.toolRunner(p)) {
          last = msg;
          const u = msg.usage || {};
          usage.input += u.input_tokens || 0; usage.output += u.output_tokens || 0;
          usage.cacheRead += u.cache_read_input_tokens || 0; usage.cacheWrite += u.cache_creation_input_tokens || 0;
        }
      };
      try { await run(params); }
      catch (e) {
        // the refusal fallback is a beta option: if the API ever refuses the option itself, ask without it
        if (!(e && e.status === 400 && /fallback/i.test(e.message || ''))) throw e;
        const { betas, fallbacks, ...plain } = params; last = null;
        await run(plain);
      }
      if (!last) throw new Error('No answer came back.');
      if (last.stop_reason === 'refusal') return send({ error: 'Claude declined to answer that one. Try asking it another way.' }), res.end();
      const text = last.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const cost = (usage.input * PRICE.input + usage.output * PRICE.output + usage.cacheRead * PRICE.cacheRead + usage.cacheWrite * PRICE.cacheWrite) / 1e6;
      send({ answer: text || (last.stop_reason === 'max_tokens' ? 'The answer ran too long. Ask for something narrower.' : 'No answer came back.'), cost: Math.round(cost * 1000) / 1000, model: last.model });
    } catch (e) {
      const status = e && e.status;
      const msg = status === 401 ? 'The Anthropic API key was refused: check ANTHROPIC_API_KEY in Railway.'
        : status === 429 ? 'Claude is busy right now (rate limit). Try again in a minute.'
        : status >= 500 ? 'Claude had a problem on its side. Try again in a moment.'
        : (e && e.message) || 'Something went wrong.';
      console.error('[Ask]', e && e.message);
      send({ error: msg });
    }
    res.end();
  });
};

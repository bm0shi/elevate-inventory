// ============================================================
// FINANCE — one engine behind four screens:
//   Monthly P&L · Product Profit · Cash & Draws · Data Sources
//
// Principles
//  - Fees come only from Amazon settlements (reconciled to their deposits).
//  - COGS is MATCHED: cost of units SOLD in the period, never what was bought.
//    A September buy becomes inventory, not a September loss.
//  - Sales tax Amazon collects and remits is excluded from sales and fees.
//  - Reserve holds/releases are balance movements, not expenses.
//  - Anything not yet tracked returns null and is shown as missing — never 0.
// ============================================================

module.exports = function registerFinance(app, deps) {
  const { pool, ownerAuth, INBOUND_FEE_PATTERNS, isPassThroughTax } = deps;

  // ---------- schema ----------
  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_overhead (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT,
        monthly_amount NUMERIC NOT NULL DEFAULT 0,
        start_month TEXT,          -- 'YYYY-MM'; null = always
        end_month TEXT,            -- 'YYYY-MM'; null = ongoing
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fin_supplies (
        size_key TEXT PRIMARY KEY,
        label TEXT,
        per_unit NUMERIC,
        sort INT DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fin_cash (
        id SERIAL PRIMARY KEY,
        as_of DATE NOT NULL,
        bank_cash NUMERIC,
        amazon_balance NUMERIC,
        inventory_value NUMERIC,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fin_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    const sizes = [
      ['liter',   'Liter (33.8 oz)',           1],
      ['mid',     '16.9 oz',                   2],
      ['regular', '8.5 – 10.14 oz',            3],
      ['small',   'Small / styling (≤ 6.8 oz)',4],
      ['duo',     'Duo / bundle',              5],
      ['other',   'Anything else',             6]
    ];
    for (const [k, l, s] of sizes) {
      await pool.query(`INSERT INTO fin_supplies(size_key,label,sort) VALUES($1,$2,$3) ON CONFLICT (size_key) DO NOTHING`, [k, l, s]);
    }
    console.log('[Finance] tables ready.');
  })().catch(e => console.error('[Finance] schema failed:', e.message));

  // ---------- helpers ----------
  const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  const monthKey = d => { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
  const monthStart = m => `${m}-01`;
  const nextMonth = m => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
  const lastNMonths = n => {
    const out = []; let m = monthKey(new Date());
    for (let i = 0; i < n; i++) { out.unshift(m); const [y, mo] = m.split('-').map(Number); m = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`; }
    return out;
  };

  function sizeKey(name) {
    const n = String(name || '').toLowerCase();
    if (/\bduo\b|\bkit\b|\bset\b|\+.*\+|two-pack|2-pack|bundle/.test(n)) return 'duo';
    if (/33\.8|\bliter\b|\blitre\b|1000\s?ml|\b1\s?l\b/.test(n)) return 'liter';
    if (/16\.9|500\s?ml/.test(n)) return 'mid';
    if (/10\.14|8\.5|6\.8|300\s?ml|250\s?ml|200\s?ml/.test(n)) return 'regular';
    if (/\b[0-6](\.\d+)?\s?(fl\.?\s?)?oz\b|\b\d{2,3}\s?(ml|g)\b/.test(n)) return 'small';
    return 'other';
  }

  async function getSettings() {
    const r = await pool.query('SELECT key, value FROM fin_settings');
    const s = {}; for (const x of r.rows) s[x.key] = x.value;
    return {
      nextBuyTarget: num(s.next_buy_target),
      nextBuyMonth: s.next_buy_month || null,
      bufferMonths: num(s.buffer_months) != null ? num(s.buffer_months) : 2
    };
  }

  async function productInfo() {
    const r = await pool.query('SELECT asin, name, image, avg_cost, regular_cost FROM inv_products');
    const m = {};
    for (const p of r.rows) m[p.asin] = { name: p.name, image: p.image, avgCost: num(p.avg_cost), regularCost: num(p.regular_cost), size: sizeKey(p.name) };
    return m;
  }

  async function supplyRates() {
    const r = await pool.query('SELECT size_key, per_unit FROM fin_supplies');
    const m = {}; for (const x of r.rows) m[x.size_key] = num(x.per_unit);
    return m;
  }

  // Inbound freight + placement per unit, per ASIN, from shipment costs.
  async function inboundPerUnit() {
    const out = {};
    try {
      const ships = await pool.query(`
        SELECT s.shipment_id,
               COALESCE((SELECT SUM(qty) FROM inv_shipment_items i WHERE i.shipment_id=s.shipment_id),0)::int AS units,
               COALESCE((SELECT SUM(amount) FROM inv_shipment_costs c WHERE c.shipment_id=s.shipment_id),0)::numeric AS cost
        FROM inv_shipments s`);
      const per = {};
      for (const r of ships.rows) if (r.units > 0 && Number(r.cost) > 0) per[r.shipment_id] = Number(r.cost) / r.units;
      const items = await pool.query('SELECT shipment_id, asin, qty FROM inv_shipment_items WHERE asin IS NOT NULL');
      const acc = {};
      for (const it of items.rows) {
        const p = per[it.shipment_id]; if (p == null || !it.qty) continue;
        const a = acc[it.asin] = acc[it.asin] || { u: 0, c: 0 };
        a.u += it.qty; a.c += p * it.qty;
      }
      for (const k of Object.keys(acc)) out[k] = acc[k].u ? acc[k].c / acc[k].u : null;
    } catch (e) { console.error('[Finance] inbound per unit:', e.message); }
    return out;
  }

  // Labor dollars from timecards in a date window.
  async function laborDollars(from, to) {
    try {
      const r = await pool.query(`
        SELECT COALESCE(SUM(
                 COALESCE(t.actual_hours,
                   GREATEST(0, EXTRACT(EPOCH FROM (t.clock_out - t.clock_in))/3600 - COALESCE(t.break_minutes,0)/60.0))
                 * COALESCE(t.wage, e.wage, 0)),0)::numeric AS dollars,
               COUNT(*)::int AS cards
        FROM inv_timecards t LEFT JOIN inv_employees e ON e.id = t.employee_id
        WHERE t.work_date >= $1 AND t.work_date < $2`, [from, to]);
      const cards = r.rows[0].cards;
      return cards ? Number(r.rows[0].dollars) : null;
    } catch (e) { return null; }
  }

  // Labor per unit = trailing labor dollars / units shipped to FBA in the same window.
  async function laborPerUnit(days = 90) {
    const to = new Date(); const from = new Date(to.getTime() - days * 86400000);
    const dollars = await laborDollars(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    if (dollars == null) return { rate: null, dollars: null, units: 0, days };
    const u = await pool.query(`
      SELECT COALESCE(SUM(i.qty),0)::int AS units FROM inv_shipment_items i
      JOIN inv_shipments s ON s.shipment_id = i.shipment_id WHERE s.created_at >= $1`, [from.toISOString()]);
    const units = u.rows[0].units;
    return { rate: units ? dollars / units : null, dollars, units, days };
  }

  async function overheadFor(month) {
    const r = await pool.query(`
      SELECT id, name, category, monthly_amount FROM fin_overhead
      WHERE active AND (start_month IS NULL OR start_month <= $1) AND (end_month IS NULL OR end_month >= $1)`, [month]);
    return { total: r.rows.reduce((n, x) => n + Number(x.monthly_amount || 0), 0), items: r.rows, any: r.rows.length > 0 };
  }

  // ---------- core: aggregate settlements over a window ----------
  async function aggregate(from, to, ctx) {
    const { products, supplies, inbound, laborRate } = ctx;
    const lines = await pool.query(`
      SELECT asin, sku, amount_type, amount_description, transaction_type,
             SUM(amount)::numeric AS total, SUM(quantity)::int AS units
      FROM inv_settlement_lines
      WHERE posted_date >= $1 AND posted_date < $2
      GROUP BY asin, sku, amount_type, amount_description, transaction_type`, [from, to]);

    const isRefund = t => /refund/i.test(t || '');
    const isReserve = d => /reserve/i.test(d || '');
    const isReimb = d => /reimburs|safe-?t|warehouse ?(lost|damage)|compensat/i.test(d || '');

    const t = { sales: 0, refunds: 0, promotions: 0, fees: 0, reimbursements: 0, otherFees: 0,
                tax: 0, reserve: 0, inboundSettled: 0, units: 0, feeDetail: {} };
    const by = {};
    const P = a => by[a] = by[a] || { asin: a, units: 0, unitsRefunded: 0, sales: 0, refunds: 0, promotions: 0,
                                      fees: 0, feeDetail: {} };

    for (const r of lines.rows) {
      const amt = Number(r.total) || 0;
      const d = r.amount_description || 'Other';
      const key = r.asin || (r.sku ? 'sku:' + r.sku : null);
      if (isPassThroughTax(r.amount_type, d)) { t.tax += amt; continue; }
      if (isReserve(d)) { t.reserve += amt; continue; }
      if (INBOUND_FEE_PATTERNS.test(d)) { t.inboundSettled += amt; continue; } // allocated per unit instead

      if (r.amount_type === 'ItemPrice') {
        const principal = /principal/i.test(d);
        if (isRefund(r.transaction_type)) {
          t.refunds += amt;
          if (key) { const p = P(key); p.refunds += amt; if (principal) p.unitsRefunded += Math.abs(r.units || 0); }
        } else {
          t.sales += amt;
          if (key) { const p = P(key); p.sales += amt; if (principal) { p.units += (r.units || 0); t.units += (r.units || 0); } }
        }
      } else if (r.amount_type === 'Promotion') {
        t.promotions += amt; if (key) P(key).promotions += amt;
      } else if (r.amount_type === 'ItemFees') {
        t.fees += amt; t.feeDetail[d] = (t.feeDetail[d] || 0) + amt;
        if (key) { const p = P(key); p.fees += amt; p.feeDetail[d] = (p.feeDetail[d] || 0) + amt; }
      } else if (amt > 0 && isReimb(d)) {
        t.reimbursements += amt;
      } else {
        t.otherFees += amt; t.feeDetail[d] = (t.feeDetail[d] || 0) + amt;
      }
    }

    // matched costs per product
    let cogs = 0, supp = 0, freight = 0, labor = 0;
    let costedSales = 0, uncostedSales = 0, suppMissing = 0, freightMissingUnits = 0;
    const items = [];
    for (const key of Object.keys(by)) {
      const p = by[key];
      const asin = key.startsWith('sku:') ? null : key;
      const info = (asin && products[asin]) || {};
      const net = Math.max(0, p.units - p.unitsRefunded);
      const unitCost = info.avgCost != null ? info.avgCost : null;
      const sRate = supplies[info.size || 'other'];
      const fRate = asin ? inbound[asin] : null;

      const pCogs = unitCost != null && net > 0 ? unitCost * net : (net === 0 ? 0 : null);
      const pSupp = sRate != null ? sRate * net : null;
      const pFreight = fRate != null ? fRate * net : null;
      const pLabor = laborRate != null ? laborRate * net : null;

      if (pCogs != null) { cogs += pCogs; costedSales += p.sales; } else uncostedSales += p.sales;
      if (pSupp != null) supp += pSupp; else if (net) suppMissing += net;
      if (pFreight != null) freight += pFreight; else if (net) freightMissingUnits += net;
      if (pLabor != null) labor += pLabor;

      const netSales = p.sales + p.refunds + p.promotions;
      const known = [pCogs, pSupp, pLabor, pFreight];
      const profit = netSales + p.fees - known.reduce((n, x) => n + (x || 0), 0);
      items.push({
        asin, sku: key.startsWith('sku:') ? key.slice(4) : null,
        name: info.name || (key.startsWith('sku:') ? key.slice(4) : asin), image: info.image || null,
        units: p.units, unitsRefunded: p.unitsRefunded, netUnits: net,
        sales: p.sales, refunds: p.refunds, promotions: p.promotions, netSales,
        fees: p.fees, feeDetail: p.feeDetail,
        unitCost, regularCost: info.regularCost != null ? info.regularCost : null,
        suppliesPerUnit: sRate, laborPerUnit: laborRate, freightPerUnit: fRate,
        landedPerUnit: unitCost != null ? unitCost + (sRate || 0) + (laborRate || 0) + (fRate || 0) : null,
        cogs: pCogs, supplies: pSupp, labor: pLabor, freight: pFreight,
        profit: pCogs != null ? profit : null,
        profitPerUnit: pCogs != null && net ? profit / net : null,
        feesPerUnit: net ? p.fees / net : null,
        marginPct: pCogs != null && netSales ? (profit / netSales) * 100 : null,
        missing: [pCogs == null && 'product cost', pSupp == null && 'supplies',
                  pLabor == null && 'labor', pFreight == null && 'freight'].filter(Boolean)
      });
    }
    items.sort((a, b) => (b.profit ?? -1e12) - (a.profit ?? -1e12));

    return { totals: t, cogs, supplies: supp, freight, laborAllocated: labor, items,
             costedSales, uncostedSales, suppMissing, freightMissingUnits, hasLines: lines.rows.length > 0 };
  }

  async function context() {
    await ready;
    const [products, supplies, inbound, lab] = await Promise.all([productInfo(), supplyRates(), inboundPerUnit(), laborPerUnit(90)]);
    return { products, supplies, inbound, laborRate: lab.rate, laborInfo: lab };
  }

  // One month of P&L.
  async function monthPnl(m, ctx) {
    const from = monthStart(m), to = monthStart(nextMonth(m));
    const a = await aggregate(from, to, ctx);
    const t = a.totals;
    const laborActual = await laborDollars(from, to);          // real dollars paid that month
    const oh = await overheadFor(m);
    const anySupplies = Object.values(ctx.supplies).some(v => v != null);

    const netSales = t.sales + t.refunds + t.promotions;
    const amazonFees = t.fees + t.otherFees;                  // negative
    const cogs = (a.costedSales || !a.uncostedSales) ? a.cogs : null;
    const supplies = anySupplies ? a.supplies : null;
    const labor = laborActual;                                // null until timesheets cover the month
    const freight = a.freight || null;
    const contribution = netSales + amazonFees + t.reimbursements
                         - (cogs || 0) - (supplies || 0) - (labor || 0) - (freight || 0);
    const overhead = oh.any ? oh.total : null;
    const net = contribution - (overhead || 0);
    const costCoverage = (a.costedSales + a.uncostedSales) ? a.costedSales / (a.costedSales + a.uncostedSales) : null;

    const lineStatus = {
      sales: a.hasLines ? 'ok' : 'missing',
      fees: a.hasLines ? 'ok' : 'missing',
      cogs: cogs == null ? 'missing' : (costCoverage != null && costCoverage < 0.98 ? 'partial' : 'ok'),
      supplies: supplies == null ? 'missing' : (a.suppMissing ? 'partial' : 'ok'),
      labor: labor == null ? 'missing' : 'ok',
      freight: freight == null ? 'missing' : (a.freightMissingUnits ? 'partial' : 'ok'),
      overhead: overhead == null ? 'missing' : 'ok'
    };
    const complete = Object.values(lineStatus).every(s => s === 'ok');

    return {
      month: m, hasData: a.hasLines, units: t.units,
      sales: t.sales, refunds: t.refunds, promotions: t.promotions, netSales,
      amazonFees, reimbursements: t.reimbursements, feeDetail: t.feeDetail,
      cogs, supplies, labor, freight, contribution, overhead, overheadItems: oh.items, net,
      marginPct: netSales ? (net / netSales) * 100 : null,
      taxPassThrough: t.tax, reserveMovement: t.reserve,
      costCoverage, lineStatus, complete
    };
  }

  // ---------- endpoints: screens ----------
  app.get('/api/finance/pnl', ownerAuth, async (req, res) => {
    try {
      const n = Math.max(1, Math.min(24, Number(req.query.months) || 12));
      const ctx = await context();
      const months = [];
      for (const m of lastNMonths(n)) months.push(await monthPnl(m, ctx));
      res.json({ months, laborInfo: ctx.laborInfo });
    } catch (e) { console.error('[Finance] pnl:', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/finance/products', ownerAuth, async (req, res) => {
    try {
      const m = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
      const from = m ? monthStart(m) : (req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
      const to = m ? monthStart(nextMonth(m)) : (req.query.to || new Date(Date.now() + 86400000).toISOString().slice(0, 10));
      const ctx = await context();
      const a = await aggregate(from, to, ctx);
      res.json({ from, to, items: a.items, laborInfo: ctx.laborInfo,
                 supplyRatesSet: Object.values(ctx.supplies).some(v => v != null) });
    } catch (e) { console.error('[Finance] products:', e.message); res.status(500).json({ error: e.message }); }
  });

  async function inventoryAtCost(products) {
    let warehouse = 0, fba = 0, uncosted = 0;
    const st = await pool.query('SELECT asin, onhand FROM inv_stock');
    for (const r of st.rows) {
      const c = products[r.asin] && products[r.asin].avgCost;
      if (c != null) warehouse += c * (r.onhand || 0); else if (r.onhand) uncosted += r.onhand;
    }
    try {
      const fc = await pool.query("SELECT data FROM inv_cache WHERE cache_key='fba_inventory'");
      const rows = fc.rows.length ? (fc.rows[0].data || []) : [];
      for (const f of rows) {
        const c = products[f.asin] && products[f.asin].avgCost;
        const u = (f.fba_effective != null ? f.fba_effective : (f.fba_total || 0))
                + (f.transit_effective != null ? f.transit_effective : (f.transit || 0));
        if (c != null) fba += c * u; else if (u) uncosted += u;
      }
    } catch (e) {}
    return { warehouse, fba, total: warehouse + fba, uncostedUnits: uncosted };
  }

  app.get('/api/finance/cash', ownerAuth, async (req, res) => {
    try {
      const ctx = await context();
      const settings = await getSettings();
      const inv = await inventoryAtCost(ctx.products);
      const snaps = (await pool.query('SELECT * FROM fin_cash ORDER BY as_of DESC, id DESC LIMIT 24')).rows;
      const latest = snaps[0] || null;

      // trailing three full-or-current months of net profit
      const months = lastNMonths(3);
      let trailing = 0, trailingComplete = true;
      for (const m of months) { const p = await monthPnl(m, ctx); trailing += p.net; if (!p.complete) trailingComplete = false; }
      const oh = await overheadFor(monthKey(new Date()));

      let liquid = null, reserve = null, safe = null, why = [];
      if (latest) {
        liquid = (num(latest.bank_cash) || 0) + (num(latest.amazon_balance) || 0);
        reserve = (settings.nextBuyTarget || 0) + settings.bufferMonths * (oh.total || 0);
        safe = Math.max(0, Math.min(liquid - reserve, trailing));
        if (!settings.nextBuyTarget) why.push('No next-buy target set, so nothing is reserved for your next Cosmoprof order.');
        if (!oh.any) why.push('No overhead entered, so no operating buffer is reserved.');
        if (!trailingComplete) why.push('Recent months are missing cost lines, so profit — and this figure — is overstated.');
      } else {
        why.push('Enter today\'s bank and Amazon balances to calculate this.');
      }

      const history = snaps.slice().reverse().map(s => ({
        as_of: s.as_of, liquid: (num(s.bank_cash) || 0) + (num(s.amazon_balance) || 0),
        inventory: num(s.inventory_value),
        workingCapital: (num(s.bank_cash) || 0) + (num(s.amazon_balance) || 0) + (num(s.inventory_value) || 0)
      }));

      res.json({ latest, inventory: inv, settings, liquid, reserve, trailingProfit: trailing, trailingComplete,
                 monthlyOverhead: oh.total, safeToDraw: safe, why,
                 workingCapital: liquid != null ? liquid + inv.total : null, history });
    } catch (e) { console.error('[Finance] cash:', e.message); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/finance/cash', ownerAuth, async (req, res) => {
    try {
      const { as_of, bank_cash, amazon_balance, note } = req.body || {};
      const ctx = await context();
      const inv = await inventoryAtCost(ctx.products);
      await pool.query(`INSERT INTO fin_cash(as_of, bank_cash, amazon_balance, inventory_value, note) VALUES($1,$2,$3,$4,$5)`,
        [as_of || new Date().toISOString().slice(0, 10), num(bank_cash), num(amazon_balance), inv.total, note || null]);
      res.json({ ok: true, inventory_value: inv.total });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/finance/cash/:id', ownerAuth, async (req, res) => {
    await pool.query('DELETE FROM fin_cash WHERE id=$1', [req.params.id]); res.json({ ok: true });
  });

  // ---------- endpoints: inputs ----------
  app.get('/api/finance/overhead', ownerAuth, async (req, res) => {
    await ready;
    const r = await pool.query('SELECT * FROM fin_overhead ORDER BY active DESC, category, name');
    res.json({ items: r.rows });
  });
  app.post('/api/finance/overhead', ownerAuth, async (req, res) => {
    try {
      const { id, name, category, monthly_amount, start_month, end_month, active } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name required' });
      const vals = [name, category || null, num(monthly_amount) || 0, start_month || null, end_month || null, active !== false];
      if (id) await pool.query(`UPDATE fin_overhead SET name=$1, category=$2, monthly_amount=$3, start_month=$4, end_month=$5, active=$6 WHERE id=$7`, [...vals, id]);
      else await pool.query(`INSERT INTO fin_overhead(name, category, monthly_amount, start_month, end_month, active) VALUES($1,$2,$3,$4,$5,$6)`, vals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/finance/overhead/:id', ownerAuth, async (req, res) => {
    await pool.query('DELETE FROM fin_overhead WHERE id=$1', [req.params.id]); res.json({ ok: true });
  });

  app.get('/api/finance/supplies', ownerAuth, async (req, res) => {
    await ready;
    const r = await pool.query('SELECT * FROM fin_supplies ORDER BY sort');
    const p = await productInfo();
    const counts = {}; for (const a of Object.keys(p)) counts[p[a].size] = (counts[p[a].size] || 0) + 1;
    res.json({ items: r.rows.map(x => ({ ...x, products: counts[x.size_key] || 0 })) });
  });
  app.post('/api/finance/supplies', ownerAuth, async (req, res) => {
    try {
      for (const x of (req.body && req.body.items) || [])
        await pool.query('UPDATE fin_supplies SET per_unit=$1 WHERE size_key=$2', [num(x.per_unit), x.size_key]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/finance/settings', ownerAuth, async (req, res) => { await ready; res.json(await getSettings()); });
  app.post('/api/finance/settings', ownerAuth, async (req, res) => {
    try {
      const b = req.body || {};
      const put = (k, v) => pool.query(`INSERT INTO fin_settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [k, v == null ? null : String(v)]);
      if ('nextBuyTarget' in b) await put('next_buy_target', num(b.nextBuyTarget));
      if ('nextBuyMonth' in b) await put('next_buy_month', b.nextBuyMonth || null);
      if ('bufferMonths' in b) await put('buffer_months', num(b.bufferMonths));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- endpoint: data sources health ----------
  app.get('/api/finance/sources', ownerAuth, async (req, res) => {
    try {
      await ready;
      const q = async (sql, p) => { try { return (await pool.query(sql, p)).rows[0] || {}; } catch (e) { return {}; } };

      const set = await q(`SELECT COUNT(*)::int AS n, MAX(end_date) AS through FROM inv_settlements`);
      const rec = await q(`SELECT COUNT(*) FILTER (WHERE ABS(COALESCE(o,0) - COALESCE(s.total_amount,0)) > 1)::int AS off
                           FROM inv_settlements s
                           LEFT JOIN (SELECT settlement_id, SUM(amount) AS o FROM inv_settlement_lines GROUP BY settlement_id) l
                             ON l.settlement_id = s.settlement_id`);
      const unmatched = await q(`SELECT COUNT(DISTINCT sku)::int AS skus FROM inv_settlement_lines WHERE asin IS NULL AND sku IS NOT NULL`);

      const sold = await q(`
        SELECT COUNT(DISTINCT l.asin)::int AS sold,
               COUNT(DISTINCT l.asin) FILTER (WHERE p.avg_cost IS NOT NULL)::int AS priced
        FROM inv_settlement_lines l LEFT JOIN inv_products p ON p.asin = l.asin
        WHERE l.asin IS NOT NULL AND l.amount_type='ItemPrice' AND l.posted_date >= now() - interval '90 days'`);
      const allP = await q(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE avg_cost IS NOT NULL)::int AS priced FROM inv_products`);

      const lab = await q(`SELECT MAX(work_date) AS through, COUNT(*)::int AS n FROM inv_timecards`);
      const sup = await q(`SELECT COUNT(*) FILTER (WHERE per_unit IS NOT NULL)::int AS set, COUNT(*)::int AS n FROM fin_supplies`);
      const oh = await q(`SELECT COUNT(*) FILTER (WHERE active)::int AS n, COALESCE(SUM(monthly_amount) FILTER (WHERE active),0)::numeric AS total FROM fin_overhead`);
      const ship = await q(`SELECT COUNT(*)::int AS n,
                              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM inv_shipment_costs c WHERE c.shipment_id=s.shipment_id))::int AS costed
                            FROM inv_shipments s WHERE s.created_at >= now() - interval '120 days'`);
      const cash = await q(`SELECT MAX(as_of) AS latest FROM fin_cash`);
      const st = await getSettings();

      const daysOld = d => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;
      const sources = [
        { key: 'settlements', label: 'Amazon sales & fees',
          status: !set.n ? 'missing' : (rec.off ? 'warn' : (daysOld(set.through) > 21 ? 'warn' : 'ok')),
          detail: !set.n ? 'No settlements imported yet.'
                  : `${set.n} settlement(s) through ${String(set.through).slice(0, 10)}` + (rec.off ? ` · ${rec.off} don't match Amazon's deposit` : ' · matches Amazon deposits')
                    + (unmatched.skus ? ` · ${unmatched.skus} SKU(s) unmatched` : ''),
          feeds: 'Sales, refunds, Amazon fees' },
        { key: 'costs', label: 'Product costs',
          status: !allP.priced ? 'missing' : (sold.sold && sold.priced < sold.sold ? 'warn' : 'ok'),
          detail: `${sold.priced || 0} of ${sold.sold || 0} products sold in the last 90 days have a cost · ${allP.priced || 0} of ${allP.n || 0} overall`,
          feeds: 'COGS' },
        { key: 'labor', label: 'Labor',
          status: !lab.n ? 'missing' : (daysOld(lab.through) > 21 ? 'warn' : 'ok'),
          detail: !lab.n ? 'No timesheets imported.' : `Timesheets through ${String(lab.through).slice(0, 10)}`,
          feeds: 'Labor line and labor per unit' },
        { key: 'supplies', label: 'Supplies per unit',
          status: !sup.set ? 'missing' : (sup.set < sup.n ? 'warn' : 'ok'),
          detail: `${sup.set || 0} of ${sup.n || 0} sizes priced`, feeds: 'Supplies line' },
        { key: 'freight', label: 'Inbound freight & placement',
          status: !ship.n ? 'missing' : (ship.costed < ship.n ? 'warn' : 'ok'),
          detail: `${ship.costed || 0} of ${ship.n || 0} recent shipments have costs entered`, feeds: 'Freight line' },
        { key: 'overhead', label: 'Rent & overhead',
          status: oh.n ? 'ok' : 'missing',
          detail: oh.n ? `${oh.n} item(s) · $${Math.round(Number(oh.total)).toLocaleString()}/month` : 'Nothing entered.',
          feeds: 'Overhead line' },
        { key: 'cash', label: 'Cash balances',
          status: !cash.latest ? 'missing' : (daysOld(cash.latest) > 35 ? 'warn' : 'ok'),
          detail: cash.latest ? `Last entered ${String(cash.latest).slice(0, 10)}` : 'Not entered.',
          feeds: 'Cash & Draws' },
        { key: 'buy', label: 'Next buy target',
          status: st.nextBuyTarget ? 'ok' : 'missing',
          detail: st.nextBuyTarget ? `$${Math.round(st.nextBuyTarget).toLocaleString()}${st.nextBuyMonth ? ' for ' + st.nextBuyMonth : ''}` : 'Not set.',
          feeds: 'Safe to draw' }
      ];
      res.json({ sources });
    } catch (e) { console.error('[Finance] sources:', e.message); res.status(500).json({ error: e.message }); }
  });

  console.log('[Finance] routes registered.');
};

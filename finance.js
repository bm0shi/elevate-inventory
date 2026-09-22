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
  const { pool, ownerAuth, INBOUND_FEE_PATTERNS, isPassThroughTax, recomputeCosts } = deps;

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
      -- Full order totals from Cosmoprof, captured at cost import. Includes
      -- lines that are not mapped to a product, because the royalty is taken
      -- on everything spent, not just what can be costed.
      CREATE TABLE IF NOT EXISTS fin_purchase_orders (
        order_number TEXT PRIMARY KEY,
        order_date DATE,
        subtotal NUMERIC,
        tax NUMERIC,
        total NUMERIC,
        lines INT,
        source TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE fin_purchase_orders ADD COLUMN IF NOT EXISTS oms_id TEXT;
      -- A month's Cosmoprof spend typed in by hand. Wins over imported orders.
      CREATE TABLE IF NOT EXISTS fin_purchases_manual (
        month TEXT PRIMARY KEY,
        amount NUMERIC,
        note TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      -- Orders to leave out of Cosmoprof spend (e.g. a store order whose
      -- final invoice was also imported — same purchase, two documents).
      -- Store orders to count even though an invoice names them (e.g. the
      -- card really was charged twice).
      -- A month where the royalty holder accepted a different amount than the
      -- formula gives. The formula figure is kept and shown alongside.
      CREATE TABLE IF NOT EXISTS fin_royalty_adjust (
        month TEXT PRIMARY KEY,
        amount_paid NUMERIC NOT NULL,
        note TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fin_spend_force (
        order_number TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fin_spend_exclude (
        order_number TEXT PRIMARY KEY,
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
    // P&L starts at August 2026 — earlier months stay stored, just not shown.
    await pool.query(`INSERT INTO fin_settings(key,value) VALUES('pnl_start_month','2026-08') ON CONFLICT (key) DO NOTHING`);
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
      bufferMonths: num(s.buffer_months) != null ? num(s.buffer_months) : 2,
      royaltyPct: num(s.royalty_pct),         // % of (deposits − Cosmoprof spend); null = not set
      royaltyCarry: s.royalty_carry === 'true', // carry a negative month into the next
      pnlStartMonth: /^\d{4}-\d{2}$/.test(s.pnl_start_month || '') ? s.pnl_start_month : null
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

  // Inbound cost per unit, per ASIN, from shipment costs — split into freight
  // (carrier) and placement (Amazon's inbound placement service fee), so each
  // shows on its own P&L line. Returns { asin: { freight, placement, total } }.
  async function inboundPerUnit() {
    const out = {};
    try {
      const ships = await pool.query(`
        SELECT s.shipment_id,
               COALESCE((SELECT SUM(qty) FROM inv_shipment_items i WHERE i.shipment_id=s.shipment_id),0)::int AS units,
               COALESCE((SELECT SUM(amount) FROM inv_shipment_costs c WHERE c.shipment_id=s.shipment_id AND c.kind ILIKE '%placement%'),0)::numeric AS placement,
               COALESCE((SELECT SUM(amount) FROM inv_shipment_costs c WHERE c.shipment_id=s.shipment_id AND c.kind NOT ILIKE '%placement%'),0)::numeric AS freight
        FROM inv_shipments s
        -- Only shipments Amazon has received can have units selling. A shipment
        -- still in transit must not raise the rate on older stock selling now.
        -- Anything 60+ days old is treated as received, in case its status is stale.
        WHERE s.status = 'received' OR s.received_at IS NOT NULL OR s.created_at < now() - interval '60 days'`);
      const per = {};
      for (const r of ships.rows) {
        const f = Number(r.freight) || 0, pl = Number(r.placement) || 0;
        if (r.units > 0 && (f || pl)) per[r.shipment_id] = { f: f / r.units, p: pl / r.units };
      }
      const items = await pool.query('SELECT shipment_id, asin, qty FROM inv_shipment_items WHERE asin IS NOT NULL');
      const acc = {};
      for (const it of items.rows) {
        const p = per[it.shipment_id]; if (!p || !it.qty) continue;
        const a = acc[it.asin] = acc[it.asin] || { u: 0, f: 0, p: 0 };
        a.u += it.qty; a.f += p.f * it.qty; a.p += p.p * it.qty;
      }
      for (const k of Object.keys(acc)) if (acc[k].u)
        out[k] = { freight: acc[k].f / acc[k].u, placement: acc[k].p / acc[k].u, total: (acc[k].f + acc[k].p) / acc[k].u };
    } catch (e) { console.error('[Finance] inbound per unit:', e.message); }
    return out;
  }

  // Shipment costs not yet charged to the P&L because none of those units can
  // have sold — the shipment hasn't been received at Amazon.
  async function inboundWaiting() {
    try {
      const r = await pool.query(`
        SELECT s.shipment_id, s.created_at,
               COALESCE(SUM(c.amount) FILTER (WHERE c.kind ILIKE '%placement%'),0)::numeric AS placement,
               COALESCE(SUM(c.amount) FILTER (WHERE c.kind NOT ILIKE '%placement%'),0)::numeric AS freight
        FROM inv_shipments s JOIN inv_shipment_costs c ON c.shipment_id = s.shipment_id
        WHERE COALESCE(s.status,'in_transit') <> 'received' AND s.received_at IS NULL
          AND s.created_at >= now() - interval '60 days'
        GROUP BY s.shipment_id, s.created_at ORDER BY s.created_at DESC`);
      const list = r.rows.map(x => ({ id: x.shipment_id, created: isoDate(x.created_at), freight: Number(x.freight), placement: Number(x.placement) }));
      return { list, freight: list.reduce((n, x) => n + x.freight, 0), placement: list.reduce((n, x) => n + x.placement, 0) };
    } catch (e) { return { list: [], freight: 0, placement: 0 }; }
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
    let cogs = 0, supp = 0, freight = 0, labor = 0, freightOnly = 0, placement = 0;
    const uncosted = [];
    let costedSales = 0, uncostedSales = 0, suppMissing = 0, freightMissingUnits = 0;
    const items = [];
    for (const key of Object.keys(by)) {
      const p = by[key];
      const asin = key.startsWith('sku:') ? null : key;
      const info = (asin && products[asin]) || {};
      const net = Math.max(0, p.units - p.unitsRefunded);
      const unitCost = info.avgCost != null ? info.avgCost : null;
      const sRate = supplies[info.size || 'other'];
      const ib = asin ? inbound[asin] : null;
      const fRate = ib ? ib.total : null;

      const pCogs = unitCost != null && net > 0 ? unitCost * net : (net === 0 ? 0 : null);
      const pSupp = sRate != null ? sRate * net : null;
      const pFreight = fRate != null ? fRate * net : null;
      const pFreightOnly = ib ? ib.freight * net : null, pPlacement = ib ? ib.placement * net : null;
      const pLabor = laborRate != null ? laborRate * net : null;

      if (pCogs != null) { cogs += pCogs; costedSales += p.sales; }
      else {
        uncostedSales += p.sales;
        // Why this sale has no cost, so the fix is obvious.
        let reason, fix, missingParts = null;
        if (!asin) { reason = 'Seller SKU not linked to a product'; fix = 'link-sku'; }
        else if (!products[asin]) { reason = 'Product not in your catalog'; fix = 'catalog'; }
        else if (ctx.bundles && ctx.bundles[asin]) {
          missingParts = ctx.bundles[asin].filter(c => !products[c.component_asin] || products[c.component_asin].avgCost == null)
            .map(c => ({ asin: c.component_asin, name: products[c.component_asin] ? products[c.component_asin].name : c.component_asin }));
          reason = missingParts.length ? 'Duo — a bottle inside has no cost' : 'Duo — cost not calculated yet'; fix = 'duo';
        } else { reason = 'No cost entered'; fix = 'cost'; }
        uncosted.push({ asin, sku: key.startsWith('sku:') ? key.slice(4) : null, name: info.name || (key.startsWith('sku:') ? key.slice(4) : asin),
                        units: net, sales: p.sales, reason, fix, missingParts });
      }
      if (pSupp != null) supp += pSupp; else if (net) suppMissing += net;
      if (pFreight != null) { freight += pFreight; freightOnly += pFreightOnly; placement += pPlacement; } else if (net) freightMissingUnits += net;
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
        carrierPerUnit: ib ? ib.freight : null, placementPerUnit: ib ? ib.placement : null,
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

    return { totals: t, cogs, supplies: supp, freight, freightOnly, placement, laborAllocated: labor, items,
             costedSales, uncostedSales, suppMissing, freightMissingUnits, hasLines: lines.rows.length > 0,
             uncosted: uncosted.sort((a, b) => b.sales - a.sales) };
  }

  // Every Cosmoprof purchase the app knows about, one row per order, from three
  // places — so monthly spend never depends on which screen an invoice came in
  // through. Where the same order number appears in more than one, the most
  // complete source wins:
  //   1. fin_purchase_orders  full totals captured at cost import (incl. tax)
  //   2. inv_invoices         Order Check-In: every line, qty × unit cost
  //   3. inv_cost_history     older cost lots — mapped lines only, may be short
  function isoDate(d) {
    const t = String(d || '').trim();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    const x = new Date(t); return isNaN(x) ? null : x.toISOString().slice(0, 10);
  }
  async function purchaseOrders() {
    const byNum = {};
    const put = (o) => { if (!o.order_number || byNum[o.order_number]) return; byNum[o.order_number] = o; };
    try {
      for (const r of (await pool.query('SELECT * FROM fin_purchase_orders')).rows)
        put({ order_number: r.order_number, date: isoDate(r.order_date), lines: r.lines, total: Number(r.total) || 0,
              tax: Number(r.tax) || 0, source: r.source === 'xstore' ? 'store order' : 'invoice import', complete: true,
              oms: r.oms_id || null, isStoreOrder: r.source === 'xstore' });
    } catch (e) {}
    try {
      const inv = await pool.query(`
        SELECT i.order_number, i.invoice_date, i.status, i.oms_id, i.created_at,
               COUNT(ii.*)::int AS lines,
               COUNT(*) FILTER (WHERE ii.unit_cost IS NULL)::int AS unpriced,
               COALESCE(SUM(ii.unit_cost * COALESCE(ii.qty_expected,0)),0)::numeric AS total
        FROM inv_invoices i LEFT JOIN inv_invoice_items ii ON ii.order_number = i.order_number
        GROUP BY i.order_number, i.invoice_date, i.status, i.oms_id, i.created_at`);
      for (const r of inv.rows) {
        // No date on the invoice? Use the day it was uploaded, and say so —
        // dropping it would leave that spend out of the month entirely.
        const d = isoDate(r.invoice_date);
        put({ order_number: r.order_number, date: d || isoDate(r.created_at), dateGuessed: !d, lines: r.lines, total: Number(r.total) || 0, tax: 0,
              source: 'check-in', status: r.status, unpriced: r.unpriced, complete: !r.unpriced, oms: r.oms_id || null });
      }
    } catch (e) {}
    try {
      const ch = await pool.query(`
        SELECT order_number, MIN(invoice_date) AS d, COUNT(*)::int AS lines,
               SUM(unit_cost * COALESCE(qty,0))::numeric AS total
        FROM inv_cost_history WHERE order_number <> 'MANUAL' GROUP BY order_number`);
      for (const r of ch.rows)
        put({ order_number: r.order_number, date: isoDate(r.d), lines: r.lines, total: Number(r.total) || 0, tax: 0,
              source: 'cost lots', complete: false, note: 'mapped lines only — may be short' });
    } catch (e) {}
    let excluded = new Set();
    try { excluded = new Set((await pool.query('SELECT order_number FROM fin_spend_exclude')).rows.map(r => r.order_number)); } catch (e) {}
    let forced = new Set();
    try { forced = new Set((await pool.query('SELECT order_number FROM fin_spend_force')).rows.map(r => r.order_number)); } catch (e) {}
    // A store order is replaced by any invoice that names it in its FS field.
    // The invoice is what actually shipped and was billed, so it wins.
    const replacedBy = {};
    for (const o of Object.values(byNum)) {
      if (o.isStoreOrder || !o.oms) continue;
      (replacedBy[o.oms] = replacedBy[o.oms] || []).push(o.order_number);
    }
    return Object.values(byNum).map(o => {
      const rep = (o.isStoreOrder || /^D\d{7,}$/i.test(o.order_number)) ? replacedBy[String(o.order_number).toUpperCase()] : null;
      const force = forced.has(o.order_number);
      return { ...o, month: o.date ? o.date.slice(0, 7) : null,
               replacedBy: rep || null, forced: force,
               excluded: excluded.has(o.order_number) || (!!rep && !force) };
    })
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  // Royalty worksheet, month by month, from the first month with a deposit.
  //   base    = Amazon deposits received that month − Cosmoprof spend that month
  //   royalty = pct × base, never below zero; with carry-forward on, a negative
  //             base is carried into the next month instead of being forgiven.
  async function royaltySeries(settings) {
    const out = {};
    const dep = (await pool.query(`
      SELECT to_char(deposit_date,'YYYY-MM') AS m, SUM(total_amount)::numeric AS amt, COUNT(*)::int AS n
      FROM inv_settlements WHERE deposit_date IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
    const allOrders = await purchaseOrders();
    const po = [];
    const agg = {};
    for (const o of allOrders) {
      if (!o.month || o.excluded) continue;
      const a = agg[o.month] = agg[o.month] || { m: o.month, amt: 0, n: 0, incomplete: 0 };
      a.amt += o.total; a.n++; if (!o.complete) a.incomplete++;
    }
    for (const k of Object.keys(agg)) po.push(agg[k]);
    const man = (await pool.query('SELECT month, amount, note FROM fin_purchases_manual')).rows;
    let adj = {};
    try { for (const r of (await pool.query('SELECT month, amount_paid, note FROM fin_royalty_adjust')).rows)
            adj[r.month] = { paid: Number(r.amount_paid), note: r.note }; } catch (e) {}
    const poBy = {}; for (const r of po) poBy[r.m] = { amt: Number(r.amt), n: r.n, incomplete: r.incomplete };
    const ordersBy = {}; for (const o of allOrders) if (o.month) (ordersBy[o.month] = ordersBy[o.month] || []).push(o);
    const manBy = {}; for (const r of man) manBy[r.month] = { amt: num(r.amount), note: r.note };
    const depBy = {}; for (const r of dep) depBy[r.m] = { amt: Number(r.amt), n: r.n };

    const all = [...new Set([...Object.keys(depBy), ...Object.keys(poBy), ...Object.keys(manBy)])].sort();
    if (!all.length) return out;
    let m = all[0]; const end = monthKey(new Date());
    const pct = settings.royaltyPct;
    let carry = 0;
    while (m <= end) {
      const deposits = depBy[m] ? depBy[m].amt : 0;
      let purchases = 0, purchasesSource = 'none', orders = 0, note = null, incomplete = 0;
      const fromOrders = poBy[m] ? poBy[m].amt : 0;
      if (manBy[m] && manBy[m].amt != null) { purchases = manBy[m].amt; purchasesSource = 'manual'; note = manBy[m].note; }
      else if (poBy[m]) { purchases = poBy[m].amt; purchasesSource = 'orders'; orders = poBy[m].n; incomplete = poBy[m].incomplete; }
      const base = deposits - purchases;
      const carryIn = settings.royaltyCarry ? carry : 0;
      const adjusted = base + carryIn;
      const calculated = pct == null ? null : Math.round(Math.max(0, adjusted) * pct) / 100;
      // An agreed amount replaces the formula figure for this month only.
      const agreed = adj[m] || null;
      const royalty = agreed ? agreed.paid : calculated;
      carry = settings.royaltyCarry && adjusted < 0 ? adjusted : 0;
      out[m] = { month: m, deposits, depositCount: depBy[m] ? depBy[m].n : 0, purchases, purchasesSource,
                 orders, incomplete, fromOrders, orderList: ordersBy[m] || [], note, base, carryIn, adjusted, royalty, carryOut: carry, pct,
                 calculated, agreed: agreed ? { paid: agreed.paid, note: agreed.note, difference: calculated != null ? agreed.paid - calculated : null } : null };
      m = nextMonth(m);
    }
    return out;
  }

  async function context() {
    await ready;
    const [products, supplies, inbound, lab] = await Promise.all([productInfo(), supplyRates(), inboundPerUnit(), laborPerUnit(90)]);
    const settings = await getSettings();
    let royalty = {};
    try { royalty = await royaltySeries(settings); } catch (e) { console.error('[Finance] royalty:', e.message); }
    const waiting = await inboundWaiting();
    let bundles = {};
    try { for (const b of (await pool.query('SELECT bundle_asin, component_asin, qty FROM inv_bundles')).rows)
            (bundles[b.bundle_asin] = bundles[b.bundle_asin] || []).push(b); } catch (e) {}
    return { products, supplies, inbound, laborRate: lab.rate, laborInfo: lab, settings, royalty, bundles, waiting };
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
    const deposited = netSales + amazonFees + t.reimbursements;

    // Which days of this month the settlement data actually covers. Amazon's
    // API returns roughly 90 days of settlements, so the oldest and newest
    // months are usually partial and must not be read as full months.
    const cov = (await pool.query(
      `SELECT MIN(posted_date) AS a, MAX(posted_date) AS b FROM inv_settlement_lines
       WHERE posted_date >= $1 AND posted_date < $2`, [from, to])).rows[0] || {};
    const endOfMonth = new Date(new Date(to).getTime() - 86400000);
    const firstDay = cov.a ? new Date(cov.a) : null, lastDay = cov.b ? new Date(cov.b) : null;
    const isCurrent = m === monthKey(new Date());
    const partial = !!firstDay && (firstDay.getUTCDate() > 3 ||
                    (lastDay && (endOfMonth - lastDay) / 86400000 > 3 && !isCurrent) || isCurrent);
    const coverage = firstDay ? { from: firstDay.toISOString().slice(0, 10), to: lastDay.toISOString().slice(0, 10),
                                  days: Math.round((lastDay - firstDay) / 86400000) + 1, partial, isCurrent } : null;

    // Royalty is 15% of (Amazon deposits − Cosmoprof spend) for the month —
    // a cash formula, worked out separately in royaltySeries().
    const roy = (ctx.royalty && ctx.royalty[m]) || null;
    const royalty = roy ? roy.royalty : null;
    const royaltyPct = ctx.settings ? ctx.settings.royaltyPct : null;

    // What Amazon actually PAID into the bank this month, by deposit date —
    // the exact total each settlement states. This is the figure that matches
    // a bank or card statement; 'deposited' above is what was EARNED.
    let payouts = [], paidToBank = null;
    try {
      payouts = (await pool.query(
        `SELECT settlement_id, start_date, end_date, deposit_date, total_amount::numeric AS amt
         FROM inv_settlements WHERE deposit_date >= $1 AND deposit_date < $2 ORDER BY deposit_date`, [from, to])).rows
        .map(r => ({ id: r.settlement_id, from: isoDate(r.start_date), to: isoDate(r.end_date),
                     paid: isoDate(r.deposit_date), amount: Number(r.amt) || 0 }));
      if (payouts.length) paidToBank = payouts.reduce((n, x) => n + x.amount, 0);
    } catch (e) {}
    const cogs = (a.costedSales || !a.uncostedSales) ? a.cogs : null;
    const supplies = anySupplies ? a.supplies : null;
    const labor = laborActual;                                // null until timesheets cover the month
    // $0 is a real answer when the only shipments with fees entered haven't
    // been received yet — nothing that sold went through them. Only call it
    // 'not tracked' when no shipment has any fees entered at all.
    const anyWaiting = !!(ctx.waiting && ctx.waiting.list && ctx.waiting.list.length);
    const anyRates = Object.keys(ctx.inbound || {}).length > 0;
    const known = a.freight || anyRates || anyWaiting;
    const freight = known ? (a.freight || 0) : null;
    const carrier = known ? (a.freight ? a.freightOnly : 0) : null;
    const placement = known ? (a.freight ? a.placement : 0) : null;
    const freightNote = !a.freight && anyWaiting && !anyRates ? 'waiting — fees are on shipments not yet received'
                      : (a.freightMissingUnits ? a.freightMissingUnits + ' unit(s) sold from shipments with no fees entered' : null);
    const contribution = deposited
                         - (cogs || 0) - (supplies || 0) - (labor || 0) - (freight || 0);
    const overhead = oh.any ? oh.total : null;
    const net = contribution - (overhead || 0) - (royalty || 0);
    const costCoverage = (a.costedSales + a.uncostedSales) ? a.costedSales / (a.costedSales + a.uncostedSales) : null;

    const lineStatus = {
      sales: a.hasLines ? 'ok' : 'missing',
      fees: a.hasLines ? 'ok' : 'missing',
      cogs: cogs == null ? 'missing' : (costCoverage != null && costCoverage < 0.98 ? 'partial' : 'ok'),
      royalty: royalty == null ? 'missing' : (roy && roy.purchasesSource === 'none' ? 'partial' : 'ok'),
      supplies: supplies == null ? 'missing' : (a.suppMissing ? 'partial' : 'ok'),
      labor: labor == null ? 'missing' : 'ok',
      freight: freight == null ? 'missing' : ((a.freightMissingUnits || (!a.freight && anyWaiting)) ? 'partial' : 'ok'),
      overhead: overhead == null ? 'missing' : 'ok'
    };
    const complete = Object.values(lineStatus).every(s => s === 'ok');

    return {
      month: m, hasData: a.hasLines, units: t.units,
      sales: t.sales, refunds: t.refunds, promotions: t.promotions, netSales,
      amazonFees, reimbursements: t.reimbursements, deposited, paidToBank, payouts, feeDetail: t.feeDetail,
      cogs, royalty, royaltyPct, royaltyCalc: roy, supplies, labor, freight, carrier, placement, freightNote, contribution, overhead, overheadItems: oh.items, net,
      // A margin with most of COGS missing is fiction. Withhold it until at
      // least 90% of sales carry a real product cost.
      marginPct: netSales && costCoverage != null && costCoverage >= 0.9 ? (net / netSales) * 100 : null,
      marginWithheld: !!netSales && (costCoverage == null || costCoverage < 0.9),
      coverage,
      taxPassThrough: t.tax, reserveMovement: t.reserve,
      costCoverage, lineStatus, complete, uncosted: a.uncosted.slice(0, 40), uncostedCount: a.uncosted.length
    };
  }

  // ---------- endpoints: screens ----------
  app.get('/api/finance/pnl', ownerAuth, async (req, res) => {
    try {
      const n = Math.max(1, Math.min(24, Number(req.query.months) || 12));
      const ctx = await context();
      const start = ctx.settings.pnlStartMonth;
      const showAll = req.query.all === '1';
      const window = lastNMonths(n);
      const hidden = start && !showAll ? window.filter(m => m < start) : [];
      const months = [];
      for (const m of window) if (!hidden.includes(m)) months.push(await monthPnl(m, ctx));
      res.json({ months, laborInfo: ctx.laborInfo, inboundWaiting: ctx.waiting,
                 startMonth: start, hiddenMonths: hidden, showingAll: showAll });
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
      const months = lastNMonths(3).filter(m => !settings.pnlStartMonth || m >= settings.pnlStartMonth);
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

  app.get('/api/finance/royalty', ownerAuth, async (req, res) => {
    try {
      await ready;
      const settings = await getSettings();
      const series = await royaltySeries(settings);
      const orders = (await pool.query('SELECT * FROM fin_purchase_orders ORDER BY order_date DESC NULLS LAST LIMIT 100')).rows;
      res.json({ settings, months: Object.values(series), orders });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/finance/royalty-adjust', ownerAuth, async (req, res) => {
    try {
      const { month, amount, note } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
      if (amount === '' || amount == null) {
        await pool.query('DELETE FROM fin_royalty_adjust WHERE month=$1', [month]);
        return res.json({ ok: true, cleared: true });
      }
      const a = num(amount);
      if (a == null || a < 0) return res.status(400).json({ error: 'Enter the amount actually paid (0 or more).' });
      await pool.query(`INSERT INTO fin_royalty_adjust(month, amount_paid, note, updated_at) VALUES($1,$2,$3,now())
                        ON CONFLICT (month) DO UPDATE SET amount_paid=$2, note=$3, updated_at=now()`, [month, a, note || null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/finance/spend-force', ownerAuth, async (req, res) => {
    try {
      const { order_number, force } = req.body || {};
      if (!order_number) return res.status(400).json({ error: 'order_number required' });
      if (force) await pool.query('INSERT INTO fin_spend_force(order_number) VALUES($1) ON CONFLICT DO NOTHING', [order_number]);
      else await pool.query('DELETE FROM fin_spend_force WHERE order_number=$1', [order_number]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/finance/spend-exclude', ownerAuth, async (req, res) => {
    try {
      const { order_number, exclude } = req.body || {};
      if (!order_number) return res.status(400).json({ error: 'order_number required' });
      if (exclude) await pool.query('INSERT INTO fin_spend_exclude(order_number) VALUES($1) ON CONFLICT DO NOTHING', [order_number]);
      else await pool.query('DELETE FROM fin_spend_exclude WHERE order_number=$1', [order_number]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/finance/purchases', ownerAuth, async (req, res) => {
    try {
      const { month, amount, note } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month must be YYYY-MM' });
      if (amount === '' || amount == null) await pool.query('DELETE FROM fin_purchases_manual WHERE month=$1', [month]);
      else await pool.query(`INSERT INTO fin_purchases_manual(month, amount, note, updated_at) VALUES($1,$2,$3,now())
                             ON CONFLICT (month) DO UPDATE SET amount=$2, note=$3, updated_at=now()`, [month, num(amount), note || null]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- missing-cost worklist ----------
  // Products ranked by how much uncosted sales they carry, so the first few you
  // price fix the most of the P&L.
  app.get('/api/finance/missing-costs', ownerAuth, async (req, res) => {
    try {
      await ready;
      const showAll = req.query.all === '1';
      const r = await pool.query(`
        WITH sold AS (
          SELECT asin, SUM(quantity)::int AS units, SUM(amount)::numeric AS sales
          FROM inv_settlement_lines
          WHERE asin IS NOT NULL AND amount_type='ItemPrice' AND amount_description ILIKE '%principal%'
            AND transaction_type NOT ILIKE '%refund%' AND posted_date >= now() - interval '90 days'
          GROUP BY asin),
        man AS (SELECT asin, unit_cost, invoice_date FROM inv_cost_history WHERE order_number='MANUAL'),
        lots AS (SELECT asin, COUNT(*)::int AS n FROM inv_cost_history WHERE order_number <> 'MANUAL' GROUP BY asin),
        cm AS (SELECT asin, string_agg(DISTINCT cosmo_num, ', ') AS cosmo FROM inv_cosmo_map WHERE asin IS NOT NULL GROUP BY asin)
        SELECT p.asin, p.name, p.image, p.avg_cost, p.regular_cost,
               COALESCE(sold.units,0) AS units, COALESCE(sold.sales,0)::numeric AS sales,
               man.unit_cost AS manual_cost, man.invoice_date AS manual_date,
               COALESCE(lots.n,0) AS invoice_lots, cm.cosmo
        FROM inv_products p
        LEFT JOIN sold ON sold.asin = p.asin
        LEFT JOIN man  ON man.asin  = p.asin
        LEFT JOIN lots ON lots.asin = p.asin
        LEFT JOIN cm   ON cm.asin   = p.asin
        WHERE ${showAll ? 'TRUE' : '(p.avg_cost IS NULL OR (man.asin IS NOT NULL AND COALESCE(lots.n,0)=0))'}
        ORDER BY COALESCE(sold.sales,0) DESC, p.name`);
      // Duos are costed from their components, so they are never priced
      // directly. Take them off the list and credit their sales to each
      // component instead, so a bottle that mostly sells inside a duo still
      // ranks where it belongs.
      const bm = (await pool.query('SELECT bundle_asin, component_asin, qty FROM inv_bundles')).rows;
      const bundleOf = {}; for (const b of bm) (bundleOf[b.bundle_asin] = bundleOf[b.bundle_asin] || []).push(b);
      const byA = {}; for (const x of r.rows) byA[x.asin] = x;
      const allSold = (await pool.query(`
        SELECT l.asin, SUM(l.quantity)::int AS units, SUM(l.amount)::numeric AS sales, MAX(p.name) AS name
        FROM inv_settlement_lines l LEFT JOIN inv_products p ON p.asin = l.asin
        WHERE l.asin IS NOT NULL AND l.amount_type='ItemPrice' AND l.amount_description ILIKE '%principal%'
          AND l.transaction_type NOT ILIKE '%refund%' AND l.posted_date >= now() - interval '90 days'
        GROUP BY l.asin`)).rows;
      const soldBy = {}; for (const x of allSold) soldBy[x.asin] = x;
      const via = {};   // component -> [{ bundle, name, units, sales }]
      for (const b of Object.keys(bundleOf)) {
        const sb = soldBy[b]; if (!sb || !Number(sb.units)) continue;
        const parts = bundleOf[b]; const nParts = parts.reduce((n, c) => n + (Number(c.qty) || 1), 0) || 1;
        for (const c of parts) {
          const q = Number(c.qty) || 1;
          (via[c.component_asin] = via[c.component_asin] || []).push({
            bundle: b, name: sb.name || b, units: Number(sb.units) * q, sales: Number(sb.sales) * q / nParts });
        }
      }
      // components missing from the base list (priced ones are filtered out) — pull them in if uncosted
      const need = Object.keys(via).filter(a => !byA[a]);
      if (need.length) {
        const extra = await pool.query(`
          SELECT p.asin, p.name, p.image, p.avg_cost, p.regular_cost, 0 AS units, 0 AS sales,
                 (SELECT unit_cost FROM inv_cost_history h WHERE h.asin=p.asin AND h.order_number='MANUAL') AS manual_cost,
                 NULL AS manual_date,
                 (SELECT COUNT(*) FROM inv_cost_history h WHERE h.asin=p.asin AND h.order_number<>'MANUAL')::int AS invoice_lots,
                 (SELECT string_agg(DISTINCT cosmo_num, ', ') FROM inv_cosmo_map m WHERE m.asin=p.asin) AS cosmo
          FROM inv_products p WHERE p.asin = ANY($1)`, [need]);
        for (const x of extra.rows) if (showAll || x.avg_cost == null) { r.rows.push(x); byA[x.asin] = x; }
      }
      r.rows = r.rows.filter(x => !bundleOf[x.asin]);
      const items = r.rows.map(x => ({
        asin: x.asin, name: x.name, image: x.image, cosmo: x.cosmo,
        units90: Number(x.units), sales90: Number(x.sales),
        cost: x.avg_cost == null ? null : Number(x.avg_cost),
        manualCost: x.manual_cost == null ? null : Number(x.manual_cost),
        manualDate: x.manual_date, invoiceLots: Number(x.invoice_lots),
        state: Number(x.invoice_lots) ? 'invoice' : (x.manual_cost != null ? 'manual' : 'none'),
        viaDuo: via[x.asin] || []
      })).map(x => {
        const dUnits = x.viaDuo.reduce((n, v) => n + v.units, 0), dSales = x.viaDuo.reduce((n, v) => n + v.sales, 0);
        return { ...x, soloUnits: x.units90, soloSales: x.sales90, units90: x.units90 + dUnits, sales90: x.sales90 + dSales };
      }).sort((a, b) => b.sales90 - a.sales90);
      const bundleCount = Object.keys(bundleOf).length;
      const tot = await pool.query(`
        SELECT COALESCE(SUM(amount),0)::numeric AS s,
               COALESCE(SUM(amount) FILTER (WHERE p.avg_cost IS NOT NULL),0)::numeric AS c
        FROM inv_settlement_lines l LEFT JOIN inv_products p ON p.asin = l.asin
        WHERE l.amount_type='ItemPrice' AND l.amount_description ILIKE '%principal%'
          AND l.transaction_type NOT ILIKE '%refund%' AND l.posted_date >= now() - interval '90 days'`);
      const s90 = Number(tot.rows[0].s), c90 = Number(tot.rows[0].c);
      res.json({ items, sales90: s90, costedSales90: c90, coverage: s90 ? c90 / s90 : null, bundleCount });
    } catch (e) { console.error('[Finance] missing-costs:', e.message); res.status(500).json({ error: e.message }); }
  });

  // Attach a Cosmoprof item number to a product from the costs worklist.
  // Accepts the 7-digit store form (1570131) and stores the 6-digit invoice
  // form (570131). Refuses to silently move a number that already belongs to a
  // different product — that would misroute every future invoice line.
  app.post('/api/finance/add-cosmo', ownerAuth, async (req, res) => {
    try {
      let { asin, cosmo_num, force } = req.body || {};
      cosmo_num = String(cosmo_num || '').replace(/\D/g, '');
      if (cosmo_num.length === 7 && cosmo_num[0] === '1') cosmo_num = cosmo_num.slice(1);
      if (!asin || !/^\d{6}$/.test(cosmo_num)) return res.status(400).json({ error: 'Enter a 6-digit Cosmoprof item number (or the 7-digit one starting with 1).' });
      const cur = await pool.query(
        `SELECT m.asin, p.name FROM inv_cosmo_map m LEFT JOIN inv_products p ON p.asin = m.asin WHERE m.cosmo_num=$1`, [cosmo_num]);
      if (cur.rows.length && cur.rows[0].asin && cur.rows[0].asin !== asin && !force)
        return res.json({ conflict: true, cosmo_num, otherAsin: cur.rows[0].asin, otherName: cur.rows[0].name });
      await pool.query(
        `INSERT INTO inv_cosmo_map(cosmo_num, asin, verified, source) VALUES($1,$2,false,'picked')
         ON CONFLICT (cosmo_num) DO UPDATE SET asin=$2, verified=false, verified_at=NULL, verified_upc=NULL, source='picked'`,
        [cosmo_num, asin]);
      await pool.query('UPDATE inv_invoice_items SET asin=$1 WHERE cosmo_num=$2 AND asin IS NULL', [asin, cosmo_num]);
      res.json({ ok: true, cosmo_num });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/finance/manual-cost', ownerAuth, async (req, res) => {
    try {
      const { asin, unit_cost } = req.body || {};
      if (!asin) return res.status(400).json({ error: 'asin required' });
      const c = num(unit_cost);
      if (c == null) {
        await pool.query(`DELETE FROM inv_cost_history WHERE asin=$1 AND order_number='MANUAL'`, [asin]);
      } else {
        if (c <= 0 || c > 1000) return res.status(400).json({ error: 'Enter a unit cost between $0.01 and $1,000.' });
        await pool.query(
          `INSERT INTO inv_cost_history(asin, order_number, invoice_date, unit_cost, qty)
           VALUES($1,'MANUAL',$2,$3,1)
           ON CONFLICT (order_number, asin) DO UPDATE SET unit_cost=$3, invoice_date=$2, qty=1`,
          [asin, new Date().toISOString().slice(0, 10), c]);
      }
      if (recomputeCosts) await recomputeCosts();
      // Nothing left for this product? Clear the stale blended cost.
      const left = await pool.query('SELECT COUNT(*)::int AS n FROM inv_cost_history WHERE asin=$1 AND qty > 0', [asin]);
      if (!left.rows[0].n) await pool.query('UPDATE inv_products SET avg_cost=NULL, regular_cost=NULL, unit_cost=NULL WHERE asin=$1', [asin]);
      const p = await pool.query('SELECT avg_cost FROM inv_products WHERE asin=$1', [asin]);
      res.json({ ok: true, cost: p.rows[0] && p.rows[0].avg_cost != null ? Number(p.rows[0].avg_cost) : null });
    } catch (e) { console.error('[Finance] manual-cost:', e.message); res.status(500).json({ error: e.message }); }
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
      if ('royaltyPct' in b) await put('royalty_pct', num(b.royaltyPct));
      if ('royaltyCarry' in b) await put('royalty_carry', b.royaltyCarry ? 'true' : 'false');
      if ('pnlStartMonth' in b) await put('pnl_start_month', /^\d{4}-\d{2}$/.test(b.pnlStartMonth || '') ? b.pnlStartMonth : '');
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
        { key: 'royalty', label: 'Royalty',
          status: st.royaltyPct != null ? 'ok' : 'missing',
          detail: st.royaltyPct != null ? `${st.royaltyPct}% of (Amazon deposits − Cosmoprof spend) each month` + (st.royaltyCarry ? ', losses carried forward' : '') : 'Not set.',
          feeds: 'Royalty line' },
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

// Reimbursement finder (owner's #1, "like the paid apps"): money Amazon owes
// us that it hasn't paid, with the case text ready to send. Pure: server.js
// gathers the rows (Amazon's reimbursements report, each shipment's shipped
// vs received per SKU, refunds per order, customer returns) and passes them.
//
// Two kinds of claim:
//   inbound  — a shipment Amazon finished receiving with fewer units than we
//              sent, less what Amazon already reimbursed for that SKU;
//   refund   — a customer was refunded, nothing came back, and Amazon hasn't
//              reimbursed it.
// Lost or damaged inside Amazon's warehouses is left out: Amazon pays those
// on its own now.

const DAY = 86400000;
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')); return isNaN(n) ? 0 : n; };

// GET_FBA_REIMBURSEMENTS_DATA (tab-separated). One row per reimbursement and
// SKU; a reversal comes back as its own row with a negative quantity.
function parseReimbursements(bodies) {
  const out = [], seen = new Set();
  for (const body of [].concat(bodies)) {
    const rows = String(body || '').split(/\r?\n/).filter(l => l.trim());
    if (!rows.length) continue;
    const h = rows[0].split('\t').map(x => x.trim().toLowerCase()), at = n => h.indexOf(n);
    const I = { date: at('approval-date'), id: at('reimbursement-id'), caseId: at('case-id'), order: at('amazon-order-id'), reason: at('reason'),
      sku: at('sku'), fnsku: at('fnsku'), asin: at('asin'), name: at('product-name'), per: at('amount-per-unit'), total: at('amount-total'),
      cash: at('quantity-reimbursed-cash'), inv: at('quantity-reimbursed-inventory'), qty: at('quantity-reimbursed-total') };
    if (I.id < 0 || I.date < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].split('\t'), g = k => (I[k] >= 0 ? String(c[I[k]] || '').trim() : '');
      const ts = Date.parse(g('date'));
      if (!g('id') || isNaN(ts)) continue;
      const key = g('id') + '|' + g('sku') + '|' + g('order');
      if (seen.has(key)) continue; seen.add(key);
      out.push({ key, id: g('id'), ts, caseId: g('caseId'), order: g('order'), reason: g('reason'), sku: g('sku'), fnsku: g('fnsku'),
        asin: g('asin'), name: g('name'), perUnit: num(g('per')), total: num(g('total')),
        qtyCash: parseInt(g('cash')) || 0, qtyInv: parseInt(g('inv')) || 0, qty: parseInt(g('qty')) || 0 });
    }
  }
  return out;
}

// Refunds per order and SKU from the Finances API's RefundEventList (the
// same payloads lib/finevents.js adds up by day).
function refundOrders(payloads) {
  const out = [], seen = new Set();
  for (const p of [].concat(payloads)) {
    const ev = (p && (p.FinancialEvents || p)) || {};
    for (const e of ev.RefundEventList || []) {
      const ts = Date.parse(e.PostedDate); if (isNaN(ts) || !e.AmazonOrderId) continue;
      for (const it of e.ShipmentItemAdjustmentList || []) {
        let principal = false, amount = 0;
        for (const ch of it.ItemChargeAdjustmentList || []) {
          if (/principal/i.test(ch.ChargeType || '')) { principal = true; amount += Number(ch.ChargeAmount && ch.ChargeAmount.CurrencyAmount) || 0; }
        }
        if (!principal) continue; // a shipping-only or goodwill adjustment, not an item refund
        const qty = Math.abs(Number(it.QuantityShipped) || 0) || 1;
        const key = [e.AmazonOrderId, it.SellerSKU || '', e.PostedDate, it.OrderAdjustmentItemId || ''].join('|');
        if (seen.has(key)) continue; seen.add(key);
        out.push({ key, order: e.AmazonOrderId, sku: it.SellerSKU || '', qty, ts, amount: Math.round(amount * 100) / 100 });
      }
    }
  }
  return out;
}

const isInboundReason = r => /inbound/i.test(r || '');
const isReturnReason = r => /customer.?return|customerserviceissue|refund|general.?adjustment|return/i.test(r || '');

// Inbound shortages. recon rows: { shipment_id, name, sku, fnsku, asin,
// product, shipped, received, closed, done_at } — done_at is when Amazon
// finished (or our received date). A shipment still being counted is not
// judged; one closed less than `settleDays` ago neither (late counts land).
function inboundClaims(recon, reimb, { now = Date.now(), settleDays = 7 } = {}) {
  const bySku = {};
  for (const r of reimb || []) if (isInboundReason(r.reason) && r.sku) (bySku[r.sku] = bySku[r.sku] || []).push(r);
  const short = (recon || [])
    .filter(r => r.closed && r.shipped > r.received && (!r.done_at || now - new Date(r.done_at).getTime() >= settleDays * DAY))
    .map(r => ({ ...r, missing: r.shipped - r.received, at: r.done_at ? new Date(r.done_at).getTime() : 0 }))
    .sort((a, b) => a.at - b.at);
  // Reimbursements carry no shipment ID: what Amazon paid for a SKU covers
  // that SKU's shortages oldest first, counting only payments after the
  // shipment was created.
  const left = {};
  for (const sku of Object.keys(bySku)) left[sku] = bySku[sku].map(r => ({ ts: r.ts, qty: r.qty }));
  const out = [];
  for (const s of short) {
    let paid = 0;
    for (const r of left[s.sku] || []) {
      if (paid >= s.missing) break;
      if (r.qty <= 0 || (s.created_at && r.ts < new Date(s.created_at).getTime())) continue;
      const take = Math.min(r.qty, s.missing - paid); r.qty -= take; paid += take;
    }
    const owed = s.missing - paid;
    if (owed > 0) out.push({ type: 'inbound', key: 'in:' + s.shipment_id + ':' + s.sku, shipment_id: s.shipment_id, shipment_name: s.name || '',
      sku: s.sku, fnsku: s.fnsku || '', asin: s.asin || '', product: s.product || '', shipped: s.shipped, received: s.received,
      missing: s.missing, reimbursed: paid, owed, since: s.at || null });
  }
  return out;
}

// Refunded, nothing returned, nothing paid. A refund younger than graceDays
// is skipped: the customer may still be sending it back.
function refundClaims(refunds, returns, reimb, { now = Date.now(), graceDays = 45, maxDays = 540 } = {}) {
  const k = (o, s) => o + '|' + s;
  const ret = {}, paid = {};
  for (const r of returns || []) if (r.order) ret[k(r.order, r.sku)] = (ret[k(r.order, r.sku)] || 0) + (r.qty || 0);
  for (const r of reimb || []) if (r.order && isReturnReason(r.reason)) paid[r.order] = (paid[r.order] || 0) + (r.qty || 0);
  const by = {};
  for (const f of refunds || []) {
    const id = k(f.order, f.sku);
    const g = by[id] = by[id] || { order: f.order, sku: f.sku, qty: 0, ts: f.ts, amount: 0 };
    g.qty += f.qty; g.amount += f.amount || 0; if (f.ts > g.ts) g.ts = f.ts;
  }
  const out = [];
  for (const id of Object.keys(by)) {
    const g = by[id], age = now - g.ts;
    if (age < graceDays * DAY || age > maxDays * DAY) continue;
    // a return counts against its own SKU; a reimbursement for the order against the whole order
    const owed = g.qty - (ret[id] || 0) - (paid[g.order] || 0);
    if (owed > 0) out.push({ type: 'refund', key: 'rf:' + g.order + ':' + g.sku, order: g.order, sku: g.sku, refunded: g.qty,
      returned: ret[id] || 0, reimbursed: paid[g.order] || 0, owed, since: g.ts, refundAmount: Math.round(Math.abs(g.amount) * 100) / 100 });
  }
  return out.sort((a, b) => a.since - b.since);
}

// What a unit is likely worth to Amazon: what it paid us for this SKU
// before, else what the unit cost us. An estimate, labelled as one.
function unitValue(sku, reimb, unitCost) {
  const past = (reimb || []).filter(r => r.sku === sku && r.qty > 0 && r.perUnit > 0);
  if (past.length) return { value: past.reduce((n, r) => n + r.perUnit, 0) / past.length, basis: 'what Amazon paid for this SKU before' };
  if (unitCost > 0) return { value: unitCost, basis: 'what it cost you' };
  return { value: null, basis: '' };
}

const fmtDate = ms => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
// The message to paste into the Seller Central case.
function caseText(c, proof) {
  const own = proof && proof.order_number
    ? `\n\nProof of ownership: Cosmoprof invoice #${proof.order_number}${proof.invoice_date ? ' dated ' + proof.invoice_date : ''} (${proof.qty} units of this item). I can attach it.`
    : '';
  if (c.type === 'inbound') {
    return `Hello,\n\nShipment ${c.shipment_id}${c.shipment_name ? ' (' + c.shipment_name + ')' : ''} is closed with units missing for:\n` +
      `  SKU ${c.sku}${c.fnsku ? ' / FNSKU ' + c.fnsku : ''}${c.asin ? ' / ASIN ' + c.asin : ''}${c.product ? '\n  ' + c.product : ''}\n` +
      `  Shipped: ${c.shipped}   Received: ${c.received}   Missing: ${c.missing}` + (c.reimbursed ? `   Already reimbursed: ${c.reimbursed}` : '') + '\n\n' +
      `Please investigate the shipment and reimburse the ${c.owed} missing unit${c.owed === 1 ? '' : 's'}.` + own + '\n\nThank you.';
  }
  return `Hello,\n\nOrder ${c.order}: the customer was refunded for ${c.refunded} unit${c.refunded === 1 ? '' : 's'} of SKU ${c.sku} on ${fmtDate(c.since)}, ` +
    `and ${c.returned ? 'only ' + c.returned + ' came' : 'nothing came'} back to the fulfillment center.\n\n` +
    `Please reimburse the ${c.owed} unit${c.owed === 1 ? '' : 's'} not returned, or charge the customer, under the FBA customer returns policy.` + own + '\n\nThank you.';
}

// One case per shipment (every short SKU in it) and one per order: Seller
// Central takes a whole shipment's missing units in one case, so ten short
// SKUs across three shipments are three cases, not ten (owner: "there's gotta
// be a way to make it easier"). Each claim keeps its own key and status.
const STATUS_ORDER = ['open', 'filed', 'paid', 'dismissed'];
function groupClaims(claims, proofByAsin) {
  const by = new Map();
  for (const c of claims || []) {
    const gkey = c.type === 'inbound' ? 'in:' + c.shipment_id : 'rf:' + c.order;
    if (!by.has(gkey)) by.set(gkey, { gkey, type: c.type, shipment_id: c.shipment_id, shipment_name: c.shipment_name, order: c.order, items: [] });
    by.get(gkey).items.push(c);
  }
  const out = [];
  for (const g of by.values()) {
    const st = new Set(g.items.map(c => c.status || 'open'));
    g.status = st.has('open') ? 'open' : st.size === 1 ? [...st][0] : st.has('filed') ? 'filed' : 'paid';
    g.caseId = (g.items.find(c => c.caseId) || {}).caseId || null;
    g.owed = g.items.reduce((n, c) => n + (c.owed || 0), 0);
    const vals = g.items.map(c => c.value).filter(v => v != null);
    g.value = vals.length ? Math.round(vals.reduce((n, v) => n + v, 0) * 100) / 100 : null;
    g.paid = g.items.some(c => c.paid != null) ? Math.round(g.items.reduce((n, c) => n + (c.paid || 0), 0) * 100) / 100 : null;
    g.since = Math.min(...g.items.map(c => c.since || Infinity)); if (!isFinite(g.since)) g.since = null;
    g.keys = g.items.map(c => c.key);
    g.text = groupCaseText(g, proofByAsin || {});
    out.push(g);
  }
  return out.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || (b.value || 0) - (a.value || 0));
}

function groupCaseText(g, proofByAsin) {
  if (g.items.length === 1) return caseText(g.items[0], g.items[0].asin ? proofByAsin[g.items[0].asin] : null);
  const proofs = [...new Map(g.items.filter(c => c.asin && proofByAsin[c.asin]).map(c => [proofByAsin[c.asin].order_number + '|' + c.asin, { p: proofByAsin[c.asin], sku: c.sku }])).values()];
  const own = proofs.length ? '\n\nProof of ownership (I can attach these):\n' + proofs.map(x => `  Cosmoprof invoice #${x.p.order_number}${x.p.invoice_date ? ' dated ' + x.p.invoice_date : ''}: ${x.p.qty} units of SKU ${x.sku}`).join('\n') : '';
  const units = n => n + ' unit' + (n === 1 ? '' : 's');
  if (g.type === 'inbound') {
    return `Hello,\n\nShipment ${g.shipment_id}${g.shipment_name ? ' (' + g.shipment_name + ')' : ''} is closed with units missing for ${g.items.length} products:\n\n` +
      g.items.map((c, i) => `${i + 1}. SKU ${c.sku}${c.fnsku ? ' / FNSKU ' + c.fnsku : ''}${c.asin ? ' / ASIN ' + c.asin : ''}${c.product ? '\n   ' + c.product : ''}\n` +
        `   Shipped ${c.shipped}, received ${c.received}, missing ${c.missing}${c.reimbursed ? ` (${c.reimbursed} already reimbursed)` : ''}: ${units(c.owed)} to reimburse`).join('\n') +
      `\n\nTotal: ${units(g.owed)}. Please investigate the shipment and reimburse the missing units.` + own + '\n\nThank you.';
  }
  return `Hello,\n\nOrder ${g.order}: the customer was refunded and nothing came back to the fulfillment center for:\n\n` +
    g.items.map((c, i) => `${i + 1}. SKU ${c.sku}: refunded ${c.refunded}, returned ${c.returned || 0}, ${units(c.owed)} not returned (refunded ${fmtDate(c.since)})`).join('\n') +
    `\n\nPlease reimburse the ${units(g.owed)} not returned, or charge the customer, under the FBA customer returns policy.` + own + '\n\nThank you.';
}

module.exports = { groupClaims, groupCaseText, parseReimbursements, refundOrders, inboundClaims, refundClaims, unitValue, caseText, isInboundReason, isReturnReason };

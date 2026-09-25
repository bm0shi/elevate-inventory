// Blending purchase lots into average and regular cost. Pure.
// Moved out of server.js unchanged so it can be tested on its own
// (test/costs.test.js).

// ============================================================
// COST ENGINE
// regular_cost = the NON-SALE price: the highest price paid in the 12 months
//                up to the newest invoice. A Cosmoprof sale only ever lowers
//                the price, so the top price in a year is the standing one,
//                and a price rise takes over as soon as it's invoiced.
//                (It used to be the price paid for the most units — but
//                stock is bought heavily on sale, so the sale price won and
//                Tea Tree Leave-In showed ~$21 against a $25.20 shelf price.)
// avg_cost     = weighted average across every lot = what the stock actually
//                cost. This is the number margin should be measured against
//                in the P&L; the order screens use regular_cost.
// A lot is "on sale" when it is meaningfully under the regular price.
// ============================================================
const SALE_THRESHOLD = 0.97;
const REGULAR_WINDOW_DAYS = 365;

// Invoice dates are stored as M/D/YY (findInvoiceDate) or ISO. → ms, or null.
function invDateMs(d) {
  const s = String(d || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return Date.UTC(y, Number(m[1]) - 1, Number(m[2])); }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function blendCosts(lots) {
  if (!lots.length) return null;
  // regular = highest price in the last 12 months of invoices (undated lots
  // count as recent, so a lot with a missing date is never ignored).
  const dates = lots.map(l => invDateMs(l.invoice_date)).filter(x => x != null);
  const newest = dates.length ? Math.max(...dates) : null;
  const recent = lots.filter(l => { const t = invDateMs(l.invoice_date); return newest == null || t == null || t >= newest - REGULAR_WINDOW_DAYS * 86400000; });
  let regular = null;
  for (const l of recent) { const c = Number(l.unit_cost); if (regular == null || c > regular) regular = c; }
  regular = Math.round(regular * 10000) / 10000;
  let spend = 0, units = 0, saleUnits = 0, saleSpend = 0, regUnits = 0, regSpend = 0;
  const priced = lots.map(l => {
    const cost = Number(l.unit_cost), qty = l.qty || 0;
    const onSale = cost < regular * SALE_THRESHOLD;
    spend += cost * qty; units += qty;
    if (onSale) { saleUnits += qty; saleSpend += cost * qty; }
    else { regUnits += qty; regSpend += cost * qty; }
    return { ...l, unit_cost: cost, onSale };
  });
  return {
    regular,
    avg: units ? spend / units : regular,
    units, spend,
    saleUnits, saleSpend, regUnits, regSpend,
    lowestSale: saleUnits ? Math.min(...priced.filter(l => l.onSale).map(l => l.unit_cost)) : null,
    saved: regUnits || saleUnits ? (regular * saleUnits - saleSpend) : 0,
    lots: priced.sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
  };
}

module.exports = { SALE_THRESHOLD, REGULAR_WINDOW_DAYS, blendCosts, invDateMs };

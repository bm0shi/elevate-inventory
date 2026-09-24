// Blending purchase lots into average and regular cost. Pure.
// Moved out of server.js unchanged so it can be tested on its own
// (test/costs.test.js).

// ============================================================
// COST ENGINE
// regular_cost = the price paid for the LARGEST share of units. Cosmoprof runs
//                sales roughly twice a year, so the price behind most of the
//                volume is the standing price, not the cheapest one seen.
// avg_cost     = weighted average across every lot = what the stock actually
//                cost. This is the number margin should be measured against.
// A lot is "on sale" when it is meaningfully under the regular price.
// ============================================================
const SALE_THRESHOLD = 0.97;

function blendCosts(lots) {
  if (!lots.length) return null;
  // regular = cost carrying the most units
  const byCost = {};
  for (const l of lots) {
    const c = Number(l.unit_cost).toFixed(4);
    byCost[c] = (byCost[c] || 0) + (l.qty || 0);
  }
  let regular = null, bestQty = -1;
  for (const c of Object.keys(byCost)) {
    if (byCost[c] > bestQty) { bestQty = byCost[c]; regular = parseFloat(c); }
  }
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

module.exports = { SALE_THRESHOLD, blendCosts };

// ============================================================
// NET PROFIT FOR THE TOP SELLERS (Dashboard → Gross sales → Top 20, owner:
// "can you also have the net profit for the top 10 sellers").
//
// Settlements come about two weeks late, so Today / 7 days have no settled
// money yet. The estimate is the period's own sales, less what Amazon kept
// per unit (fees, refunds, promotions) at this listing's settled rate over
// the last months, less the landed cost of the units (product, supplies,
// labor, freight: the same per-unit numbers Product Profit uses).
//   profit = sales + units × amazonPerUnit − units × landedPerUnit
// A listing with too few settled units borrows the store-wide rate as a share
// of sales, and says so. No product cost → no number, never a guess.
// ============================================================

const MIN_SETTLED_UNITS = 5;

// settled: Product Profit's items for the look-back ({ asin, units, sales,
// refunds, promotions, fees }, money as signed amounts: fees negative).
// → { byAsin: { asin: { perUnit, units } }, storeShare } (both negative or 0)
function amazonRates(settled) {
  const byAsin = {};
  let kept = 0, sales = 0;
  for (const it of settled || []) {
    const take = (Number(it.refunds) || 0) + (Number(it.promotions) || 0) + (Number(it.fees) || 0);
    if (it.asin && it.units > 0) byAsin[it.asin] = { perUnit: take / it.units, units: it.units };
    if ((Number(it.sales) || 0) > 0) { kept += take; sales += Number(it.sales); }
  }
  return { byAsin, storeShare: sales > 0 ? kept / sales : null };
}

// row: { asin, units, sales } for the period; landed: per-unit landed cost or null.
// → { profit, perUnit, amazonPerUnit, basis: 'listing' | 'store' | null, missing }
function estimateProfit(row, rates, landed) {
  const units = Number(row.units) || 0, sales = Number(row.sales) || 0;
  if (landed == null) return { profit: null, perUnit: null, amazonPerUnit: null, basis: null, missing: 'product cost' };
  const r = rates && rates.byAsin && rates.byAsin[row.asin];
  let amazon, basis;
  if (r && r.units >= MIN_SETTLED_UNITS) { amazon = units * r.perUnit; basis = 'listing'; }
  else if (rates && rates.storeShare != null) { amazon = sales * rates.storeShare; basis = 'store'; }
  else return { profit: null, perUnit: null, amazonPerUnit: null, basis: null, missing: 'Amazon fees (no settled sales yet)' };
  const profit = sales + amazon - units * landed;
  return { profit, perUnit: units ? profit / units : null, amazonPerUnit: units ? amazon / units : null, basis, missing: null };
}

module.exports = { amazonRates, estimateProfit, MIN_SETTLED_UNITS };

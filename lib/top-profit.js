// ============================================================
// NET PROFIT FOR THE TOP SELLERS (Dashboard → Gross sales → Top 20, owner:
// "can you also have the net profit for the top 10 sellers").
//
// Settlements come about two weeks late, so Today / 7 days have no settled
// money yet. The estimate is the period's own sales, less what Amazon keeps,
// less the landed cost of the units (product, supplies, labor, freight: the
// same per-unit numbers Product Profit uses).
//
// What Amazon keeps is split the way Amazon charges it (owner 10/18: "i need
// it to be 99% accurate" — a flat dollars-per-unit average lagged a price
// rise, since the referral fee is a share of the price):
//   · a share of the price: referral fee, refunds, promotions, digital
//     services fee — measured as this listing's own % of its settled sales,
//     applied to this period's sales;
//   · per unit: FBA fulfillment and other flat fees — from the last 60 days
//     of settlements when there are enough units (Amazon changes FBA fees),
//     else the last 6 months.
//   profit = sales + sales × pctShare + units × perUnit − units × landed
// A listing with too few settled units borrows the store-wide share of
// sales, and says so. No product cost → no number, never a guess.
// ============================================================

const MIN_SETTLED_UNITS = 5;
const MIN_RECENT_UNITS = 3;

// Fees Amazon charges as a share of the price; everything else is per unit.
const PCT_FEE = /commission|referral|digital\s*services|variable\s*closing|refund/i;

// Split one listing's settled money into its share-of-price and per-unit parts.
function split(it) {
  let pct = (Number(it.refunds) || 0) + (Number(it.promotions) || 0), unit = 0;
  const detail = it.feeDetail || null;
  if (detail && Object.keys(detail).length) {
    for (const [d, v] of Object.entries(detail)) { if (PCT_FEE.test(d)) pct += Number(v) || 0; else unit += Number(v) || 0; }
  } else unit += Number(it.fees) || 0;   // no detail: treat all fees as per unit (the old behaviour)
  return { pct, unit };
}

// settled: Product Profit's items for the 6-month look-back; recent: the same
// for the last 60 days ({ asin, units, sales, refunds, promotions, fees,
// feeDetail }, signed amounts: fees negative).
// → { byAsin: { asin: { pctShare, perUnit, units, perUnitFrom } }, storeShare }
function amazonRates(settled, recent) {
  const byAsin = {}, rec = {};
  for (const it of recent || []) if (it.asin && it.units > 0) rec[it.asin] = it;
  let kept = 0, sales = 0;
  for (const it of settled || []) {
    const s = split(it), sl = Number(it.sales) || 0;
    if (it.asin && it.units > 0 && sl > 0) {
      const r = rec[it.asin];
      const recentUnit = r && r.units >= MIN_RECENT_UNITS ? split(r).unit / r.units : null;
      byAsin[it.asin] = { pctShare: s.pct / sl, perUnit: recentUnit != null ? recentUnit : s.unit / it.units,
                          perUnitFrom: recentUnit != null ? '60d' : '6mo', units: it.units };
    }
    if (sl > 0) { kept += s.pct + s.unit; sales += sl; }
  }
  return { byAsin, storeShare: sales > 0 ? kept / sales : null };
}

// row: { asin, units, sales } for the period; landed: per-unit landed cost or null.
// → { profit, perUnit, amazonPerUnit, amazonPct, amazonFixed, basis: 'listing' | 'store' | null, missing }
function estimateProfit(row, rates, landed) {
  const units = Number(row.units) || 0, sales = Number(row.sales) || 0;
  const none = { profit: null, perUnit: null, amazonPerUnit: null, amazonPct: null, amazonFixed: null, basis: null };
  if (landed == null) return Object.assign(none, { missing: 'product cost' });
  const r = rates && rates.byAsin && rates.byAsin[row.asin];
  let pctPart, unitPart, basis;
  if (r && r.units >= MIN_SETTLED_UNITS) { pctPart = sales * r.pctShare; unitPart = units * r.perUnit; basis = 'listing'; }
  else if (rates && rates.storeShare != null) { pctPart = sales * rates.storeShare; unitPart = 0; basis = 'store'; }
  else return Object.assign(none, { missing: 'Amazon fees (no settled sales yet)' });
  const amazon = pctPart + unitPart;
  const profit = sales + amazon - units * landed;
  return { profit, perUnit: units ? profit / units : null, amazonPerUnit: units ? amazon / units : null,
           amazonPct: units ? pctPart / units : null, amazonFixed: units ? unitPart / units : null, basis, missing: null };
}

module.exports = { amazonRates, estimateProfit, split, MIN_SETTLED_UNITS, MIN_RECENT_UNITS, PCT_FEE };

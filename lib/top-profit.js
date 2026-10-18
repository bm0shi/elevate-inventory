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

// WORTH REORDERING (owner 10/18: "a formula based on margin and velocity …
// no suggestions just the data"): rank by profit per day = units sold per day
// × net profit per unit (the same as margin % × sales per day), i.e. the
// dollars a listing actually earns each day. ROI (profit ÷ landed cost per
// unit) is shown beside it, not mixed in, so the score stays plain.
// rows: { profit, profitPerUnit, landed } ; days: days the period covers.
// Adds profitPerDay, roi and scoreRank (1 = best; null when no profit).
function scoreRows(rows, days) {
  const d = days > 0 ? days : 1;
  for (const r of rows) {
    r.profitPerDay = r.profit != null ? r.profit / d : null;
    r.roi = r.profitPerUnit != null && r.landed > 0 ? r.profitPerUnit / r.landed : null;
    r.scoreRank = null;
  }
  rows.filter(r => r.profitPerDay != null)
    .sort((a, b) => b.profitPerDay - a.profitPerDay || (b.roi ?? -1e9) - (a.roi ?? -1e9))
    .forEach((r, i) => { r.scoreRank = i + 1; });
  return rows;
}

// Whole days from `from` to `to` (YYYY-MM-DD, both included), starting no
// earlier than the first day with per-listing sales saved.
function daysCovered(from, to, since) {
  const start = since && since > from ? since : from;
  const ms = Date.parse(to + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z');
  return ms >= 0 ? Math.round(ms / 86400000) + 1 : 0;
}

// RISING OR FADING (owner 10/18: "Profit/day for the last 30 days next to
// the 30 days before … this is good"): the same-length stretch just before
// the period, e.g. Sep 19 – Oct 18 → Aug 20 – Sep 18.
const addDays = (ymd, k) => new Date(Date.parse(ymd + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
function prevRange(from, to) {
  const n = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  return { from: addDays(from, -n), to: addDays(from, -1), days: n };
}
// Change in profit per day: { pct, dir: 'up' | 'down' | 'flat' | 'new' | 'gone' }, or null when
// either side is unknown. pct is against the size of the earlier number, so a
// loss shrinking from −$10 to −$5/day reads as +50%.
function trend(cur, prev) {
  if (cur == null || prev == null) return null;
  if (prev === 0) return cur === 0 ? { pct: 0, dir: 'flat' } : { pct: null, dir: cur > 0 ? 'new' : 'down' };
  const pct = (cur - prev) / Math.abs(prev);
  if (cur === 0 && prev > 0) return { pct: -1, dir: 'gone' };
  return { pct, dir: Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down' };
}

module.exports = { amazonRates, estimateProfit, split, scoreRows, daysCovered, prevRange, trend, MIN_SETTLED_UNITS, MIN_RECENT_UNITS, PCT_FEE };

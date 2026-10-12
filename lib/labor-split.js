// Labor per unit by product (owner's #7, true profit per product).
//
// The labor cost used to be one rate for every unit: timesheet dollars over
// units shipped. A liter duo takes far longer to prep than a 3 oz single, so
// the same total is now split by each product's real prep time from the
// floor's own log (inv_prep_log): slow products carry more of it, quick ones
// less, and the dollars add up to the same total.
//
// No database access here; finance.js passes the rows in.

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Person-seconds one job took: each crew member's time on it, inside the
// job's own window. A job with no crew record counts its own length once.
function personSeconds(row) {
  const dur = Number(row.duration_sec) || 0;
  if (!dur) return 0;
  const crew = Array.isArray(row.crew) ? row.crew : [];
  if (!crew.length || !row.started_at) return dur;
  const s = new Date(row.started_at).getTime(), e = s + dur * 1000;
  let sum = 0;
  for (const c of crew) {
    const a = Math.max(s, new Date(c.joined_at).getTime() || s);
    const b = Math.min(e, new Date(c.left_at).getTime() || e);
    if (b > a) sum += (b - a) / 1000;
  }
  return sum > 0 ? sum : dur;
}

// Seconds per sellable unit, per ASIN: the median of its jobs, so one job
// left claimed overnight doesn't decide it. Jobs slower than maxSecPerUnit
// (10 minutes a unit) are that kind of mistake and are skipped.
function prepSeconds(rows, { maxSecPerUnit = 600 } = {}) {
  const per = {};
  for (const r of rows || []) {
    const q = Number(r.qty) || 0, ps = personSeconds(r);
    if (!r.asin || q <= 0 || ps <= 0) continue;
    const spu = ps / q;
    if (spu > maxSecPerUnit) continue;
    (per[r.asin] = per[r.asin] || { rates: [], units: 0 }).rates.push(spu);
    per[r.asin].units += q;
  }
  const out = {};
  for (const a of Object.keys(per)) out[a] = { sec: median(per[a].rates), jobs: per[a].rates.length, units: per[a].units };
  return out;
}

// Split `dollars` across products by prep time × units prepped. Products
// with no timed job get the median of the others. Returns $ per unit by ASIN
// (and the default for any other product), or null without the data.
function splitDollars(dollars, secByAsin, unitsByAsin) {
  if (dollars == null || !(dollars > 0)) return null;
  const known = Object.values(secByAsin || {}).map(x => x.sec).filter(x => x > 0);
  if (!known.length) return null;
  const fallback = median(known);
  const sec = a => (secByAsin[a] && secByAsin[a].sec > 0 ? secByAsin[a].sec : fallback);
  let weight = 0;
  for (const a of Object.keys(unitsByAsin || {})) weight += (Number(unitsByAsin[a]) || 0) * sec(a);
  if (!(weight > 0)) return null;
  const perSec = dollars / weight;
  const byAsin = {};
  for (const a of new Set([...Object.keys(secByAsin), ...Object.keys(unitsByAsin || {})])) byAsin[a] = perSec * sec(a);
  return { byAsin, fallback: perSec * fallback, perSec };
}

module.exports = { personSeconds, prepSeconds, splitDollars, median };

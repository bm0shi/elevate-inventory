// ============================================================
// PALLET LIMITS (2D Production). Pure.
// Every box goes on a numbered pallet. The floor needs to know, before
// building the next stack of boxes, whether it still fits:
//   weight  Amazon's LTL pallet limit is 1,500 lb. We plan to a SAFE limit
//           50 lb under it (unit weights from Amazon and a hand scale are
//           off by a few %; 3% of ~1,300 lb of product is ~40 lb).
//           Packaging is counted per pallet, per box and per unit, not as a
//           flat allowance: the owner first used a flat 100 lb, but a full
//           pallet is ~65 lb pallet + ~5 lb wrap, ~1.5 lb of cardboard and
//           tape per box, and a poly/bubble bag per unit — ~170 lb on a
//           48-box pallet, so the flat 100 under-counted by ~70 lb.
//   height  our own stacking limit, 60" including the pallet deck (Amazon's
//           is higher; ours is the one that binds).
// Height isn't measured box by box, so it's ESTIMATED from box volume
// spread over the pallet footprint (48×40) at a packing efficiency, and a
// tape-measured height, when entered, overrides the estimate.
// Box weight_lb = units × unit weight (what the label shows); packaging is
// added on top here (packedLb).
// ============================================================

const DEFAULTS = { maxLb: 1500, safetyLb: 50, palletLb: 70, boxPackLb: 1.5, unitPackLb: 0.05,
                   maxHeightIn: 60, deckIn: 5, footL: 48, footW: 40, fill: 0.85, warnPct: 90 };
// safetyLb may be 0 (plan right up to Amazon's limit); the rest must be > 0.
const ZERO_OK = new Set(['safetyLb', 'unitPackLb']);

function settings(s) {
  const o = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (s && s[k] != null && s[k] !== '' && isFinite(Number(s[k])) && (Number(s[k]) > 0 || (ZERO_OK.has(k) && Number(s[k]) === 0))) o[k] = Number(s[k]);
  if (o.fill > 1) o.fill = o.fill / 100;   // typed as 85 rather than 0.85
  o.limitLb = Math.max(1, o.maxLb - o.safetyLb);
  return o;
}

// A box's weight on the pallet: product + its cardboard + a bag per unit.
const packedLb = (b, s) => (Number(b.weight_lb) || 0) + s.boxPackLb + (Number(b.units) || 0) * s.unitPackLb;
const vol = (b) => (b.len > 0 && b.wid > 0 && b.hgt > 0) ? b.len * b.wid * b.hgt : 0;

// boxes: [{ weight_lb, len, wid, hgt }] on one pallet, in the order they
// were packed → totals and % of limits. measured: a tape-measured height,
// { h, count } = h inches once the first `count` boxes were on (boxes added
// after it still add their estimated height), or a plain number.
function palletStats(boxes, s, measured) {
  s = settings(s);
  boxes = boxes || [];
  const area = s.footL * s.footW * s.fill;
  const productLb = boxes.reduce((n, b) => n + (Number(b.weight_lb) || 0), 0);
  const grossBoxesLb = boxes.reduce((n, b) => n + packedLb(b, s), 0);
  const volIn3 = boxes.reduce((n, b) => n + vol(b), 0);
  const estHeight = boxes.length ? s.deckIn + volIn3 / area : 0;
  const m = typeof measured === 'number' ? { h: measured, count: boxes.length } : (measured || {});
  const mh = Number(m.h) || 0;
  const height = mh > 0 ? mh + boxes.slice(Math.min(boxes.length, Number(m.count) || 0)).reduce((n, b) => n + vol(b), 0) / area : estHeight;
  const measuredHeightIn = mh;
  const weight = boxes.length ? grossBoxesLb + s.palletLb : 0;
  const packagingLb = boxes.length ? weight - productLb : 0;
  const wPct = weight / s.limitLb * 100, hPct = height / s.maxHeightIn * 100;
  const pct = Math.max(wPct, hPct);
  return {
    boxes: boxes.length, productLb, packagingLb, weight, limitLb: s.limitLb, height, estHeight, measured: measuredHeightIn > 0,
    weightPct: wPct, heightPct: hPct,
    status: pct >= 100 ? 'full' : pct >= s.warnPct ? 'near' : 'ok',
    limitedBy: wPct >= hPct ? 'weight' : 'height',
  };
}

// How many more boxes like `box` ({ weight_lb, units, len, wid, hgt }) fit on
// a pallet that already holds `stats`, staying under the safe limit.
function boxesThatFit(stats, box, s) {
  s = settings(s);
  const base = stats.boxes ? stats : { ...stats, weight: s.palletLb, height: s.deckIn };
  const w = packedLb(box, s), v = vol(box);
  const byWeight = w > 0 ? Math.floor((s.limitLb - base.weight) / w + 1e-9) : Infinity;
  const byHeight = v > 0 ? Math.floor(((s.maxHeightIn - base.height) * s.footL * s.footW * s.fill) / v + 1e-9) : Infinity;
  const n = Math.max(0, Math.min(byWeight, byHeight));
  return { n: isFinite(n) ? n : null, byWeight, byHeight, limitedBy: byWeight <= byHeight ? 'weight' : 'height' };
}

// What to pack next on this pallet: for each product still to make, how many
// boxes fit, preferring ones that FINISH a product (no half-done SKU left
// for the next pallet), then the ones that fill the most.
// candidates: [{ asin, name, boxesLeft, box: { weight_lb, len, wid, hgt }, perBox }]
function recommend(stats, candidates, s) {
  const out = [];
  for (const c of candidates || []) {
    if (!(c.boxesLeft > 0)) continue;
    const f = boxesThatFit(stats, c.box, s);
    if (f.n == null || f.n <= 0) continue;
    const n = Math.min(f.n, c.boxesLeft);
    out.push({ asin: c.asin, name: c.name, boxes: n, units: n * (c.perBox || 0), finishes: n >= c.boxesLeft,
               lb: n * packedLb(c.box, settings(s)), limitedBy: n < c.boxesLeft ? f.limitedBy : null, boxesLeft: c.boxesLeft });
  }
  out.sort((a, b) => (b.finishes - a.finishes) || (b.lb - a.lb));
  return out;
}

module.exports = { packedLb, DEFAULTS, settings, palletStats, boxesThatFit, recommend };

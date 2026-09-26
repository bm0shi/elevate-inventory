// ============================================================
// RECOMMENDED ORDER — a blend of demand signals that learns which to trust.
// Signals, each a monthly unit estimate for OUR sales of one listing:
//   ours   our own sales, last velocity window (what actually happened)
//   ssus   SmartScout: our seller file's units (listing units × our Buy Box %)
//   keepa  Keepa's listing sales × our share of the Buy Box
//   fair   a fair share of the pie Amazon leaves (the upside if we win it)
// The app logs every signal daily. Thirty days on, the logged 'ours' figure
// is what we really sold over those 30 days, so each earlier prediction can
// be scored. Signals that keep landing close get more weight; ones that
// keep missing get less. Until enough have been scored, PRIOR_WEIGHTS hold.
// Pure: no database access.
// ============================================================

const SIGNALS = ['ours', 'ssus', 'keepa', 'fair'];
const PRIOR_WEIGHTS = { ours: 0.5, ssus: 0.25, keepa: 0.15, fair: 0.1 };
const MIN_SAMPLES = 20;     // scored predictions a signal needs before its weight is learned
const ERR_FLOOR = 0.05;     // keeps one lucky signal from taking all the weight

// Error of one prediction against what we sold: |pred − actual| ÷ actual,
// with small sellers floored at 5 units so 1-vs-2 doesn't count as 100% off.
function predError(pred, actual) {
  return Math.abs((pred || 0) - (actual || 0)) / Math.max(actual || 0, 5);
}

// samples: [{ signal, pred, actual }] → { weights, stats: {signal: {n, err}}, learned }
// A signal with MIN_SAMPLES+ scored predictions is weighted 1 / (mean error
// + floor); one with fewer keeps its prior, scaled into the same total.
function learnWeights(samples) {
  const acc = {};
  for (const s of samples || []) {
    if (!SIGNALS.includes(s.signal) || s.pred == null || s.actual == null) continue;
    const a = acc[s.signal] = acc[s.signal] || { n: 0, sum: 0 };
    a.n++; a.sum += Math.min(predError(s.pred, s.actual), 5);   // one wild miss can't dominate
  }
  const stats = {};
  for (const k of SIGNALS) stats[k] = acc[k] ? { n: acc[k].n, err: acc[k].sum / acc[k].n } : { n: 0, err: null };
  const learnedKeys = SIGNALS.filter(k => stats[k].n >= MIN_SAMPLES);
  if (!learnedKeys.length) return { weights: { ...PRIOR_WEIGHTS }, stats, learned: false };
  const raw = {};
  for (const k of learnedKeys) raw[k] = 1 / (stats[k].err + ERR_FLOOR);
  // Unlearned signals keep their prior share of the total.
  const priorLearned = learnedKeys.reduce((t, k) => t + PRIOR_WEIGHTS[k], 0);
  const rawSum = Object.values(raw).reduce((t, v) => t + v, 0);
  const weights = {};
  for (const k of SIGNALS) weights[k] = raw[k] != null ? (raw[k] / rawSum) * priorLearned : PRIOR_WEIGHTS[k];
  return { weights, stats, learned: true };
}

// Blend the signals a listing has (null = no data for it) → monthly units,
// plus the weights actually used (renormalised over the signals present).
function blend(signals, weights) {
  const w = weights || PRIOR_WEIGHTS;
  let num = 0, den = 0;
  const used = {};
  for (const k of SIGNALS) {
    const v = signals ? signals[k] : null;
    if (v == null || !isFinite(v) || !(w[k] > 0)) continue;
    num += w[k] * v; den += w[k]; used[k] = w[k];
  }
  if (!den) return { monthly: null, used: {} };
  for (const k of Object.keys(used)) used[k] = used[k] / den;
  return { monthly: num / den, used };
}

module.exports = { SIGNALS, PRIOR_WEIGHTS, MIN_SAMPLES, predError, learnWeights, blend };

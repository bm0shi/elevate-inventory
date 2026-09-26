const test = require('node:test');
const assert = require('node:assert');
const { learnWeights, blend, predError, PRIOR_WEIGHTS, MIN_SAMPLES } = require('../lib/forecast');

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test('no history yet: starting weights (our sales count most)', () => {
  const r = learnWeights([]);
  assert.strictEqual(r.learned, false);
  assert.deepStrictEqual(r.weights, PRIOR_WEIGHTS);
});

test('blend uses only the signals a listing has', () => {
  // Only our sales and Keepa: 0.5 and 0.15 renormalised.
  const b = blend({ ours: 100, ssus: null, keepa: 200, fair: null });
  near(b.monthly, (0.5 * 100 + 0.15 * 200) / 0.65);
  near(b.used.ours + b.used.keepa, 1);
  assert.strictEqual(blend({}).monthly, null);
});

test('a signal that keeps landing close gains weight over one that keeps missing', () => {
  const samples = [];
  for (let i = 0; i < MIN_SAMPLES; i++) {
    samples.push({ signal: 'ours', pred: 100, actual: 100 });   // spot on
    samples.push({ signal: 'keepa', pred: 400, actual: 100 });  // 300% off
  }
  const r = learnWeights(samples);
  assert.strictEqual(r.learned, true);
  assert.ok(r.weights.ours > r.weights.keepa * 10);
  // The two learned signals share what their priors had together; the others keep theirs.
  near(r.weights.ours + r.weights.keepa, PRIOR_WEIGHTS.ours + PRIOR_WEIGHTS.keepa);
  near(r.weights.ssus, PRIOR_WEIGHTS.ssus);
});

test('too few scored predictions: the signal keeps its prior', () => {
  const r = learnWeights([{ signal: 'fair', pred: 10, actual: 100 }]);
  assert.strictEqual(r.learned, false);
  assert.strictEqual(r.stats.fair.n, 1);
});

test('small sellers: error floored at 5 units, so 1 vs 2 is not 100% off', () => {
  near(predError(1, 2), 1 / 5);
  near(predError(150, 100), 0.5);
});

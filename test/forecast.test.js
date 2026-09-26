const test = require('node:test');
const assert = require('node:assert');
const { learnWeights, blend, predError, inStockMonthly, blendSignals, PRIOR_WEIGHTS, MIN_SAMPLES } = require('../lib/forecast');

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test('no history yet: starting weights (our sales count most)', () => {
  const r = learnWeights([]);
  assert.strictEqual(r.learned, false);
  assert.deepStrictEqual(r.weights, PRIOR_WEIGHTS);
});

test('blend uses only the signals a listing has', () => {
  // Only our sales and Keepa: 0.5 and 0.15 renormalised.
  const b = blend({ ours: 100, ssus: null, keepa: 200, fair: null });
  const w = PRIOR_WEIGHTS;
  near(b.monthly, (w.ours * 100 + w.keepa * 200) / (w.ours + w.keepa));
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

test('in stock 20 of 30 days: 300 sold is a 15/day pace, not 10', () => {
  near(inStockMonthly(300, 30, { known: 30, inStock: 20 }), 450);
  near(inStockMonthly(300, 30, { known: 30, inStock: 30 }), 300);
});

test('in-stock correction needs a week of snapshots, and caps at 4x', () => {
  assert.strictEqual(inStockMonthly(300, 30, { known: 3, inStock: 1 }), null);
  near(inStockMonthly(30, 30, { known: 10, inStock: 1 }), 120);   // 10% in stock → floored at 25%
});

test('nothing at Amazon and no history: raw sales left out of the blend (may be a stockout)', () => {
  assert.strictEqual(blendSignals({ ours: 40, fair: 300 }, { atAmazon: 0, snapKnown: 0 }).ours, null);
  assert.strictEqual(blendSignals({ ours: 40, fair: 300 }, { atAmazon: 12, snapKnown: 0 }).ours, 40);
  assert.strictEqual(blendSignals({ ours: 40, fair: 300 }, { atAmazon: 0, snapKnown: 20 }).ours, 40);
  assert.strictEqual(blendSignals({ ours: 40 }, { atAmazon: 0, snapKnown: 0 }).ours, 40);   // nothing else to go on
});

const test = require('node:test');
const assert = require('node:assert');
const { estimateShare, measuredShare, MAX_SPLIT } = require('../lib/demand');

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('our own 90-day Buy Box % is used when we know our seller id', () => {
  const m = { amazonBuyBoxPct: 88, buyBoxWinners3P: 3, offerCount: 12, bbShares: { ATVPDKIKX0DER: 88, ME: 7, X: 3, Y: 2 } };
  const r = estimateShare(m, 'ME');
  assert.strictEqual(r.src, 'ourbb');
  near(r.share, 0.07);
});

test('Tea Tree: Amazon 95%, 3 other winners, we won none → split 4 ways ≈ 1.25%', () => {
  const r = estimateShare({ amazonBuyBoxPct: 95, buyBoxWinners3P: 3, offerCount: 12, bbShares: { ATVPDKIKX0DER: 95, A: 2, B: 2, C: 1 } }, 'ME');
  assert.strictEqual(r.src, 'buybox');
  assert.strictEqual(r.ourPct, 0);
  assert.strictEqual(r.sellers3P, 4);
  near(r.share, 0.0125);
});

test('idle and FBM offers do not dilute the split (only Buy Box winners count)', () => {
  // 15 offers but only 2 third-party sellers ever won the Buy Box.
  const r = estimateShare({ amazonBuyBoxPct: 90, buyBoxWinners3P: 2, offerCount: 15 });
  assert.strictEqual(r.sellers3P, 3);
  near(r.share, 0.1 / 3);
});

test('no 90-day stats yet: Amazon holding it now assumes 90%, offer count capped', () => {
  const r = estimateShare({ amazonHasBuyBox: true, offerCount: 14 });
  assert.strictEqual(r.src, 'guess');
  assert.strictEqual(r.sellers3P, MAX_SPLIT);
  near(r.share, 0.1 / MAX_SPLIT);
});

test('no seller data at all → no estimate', () => {
  assert.strictEqual(estimateShare({}).share, null);
  assert.strictEqual(estimateShare(null).share, null);
});

test('measured share = our monthly ÷ listing monthly, capped at 100%', () => {
  assert.strictEqual(measuredShare(30, 1000), 0.03);
  assert.strictEqual(measuredShare(500, 300), 1);
  assert.strictEqual(measuredShare(0, 1000), null);
  assert.strictEqual(measuredShare(10, null), null);
});

const test = require('node:test');
const assert = require('node:assert');
const { estimateShare, measuredShare } = require('../lib/demand');

test('Amazon wins 95% of the Buy Box, us + 3 other sellers → ~1.25% each', () => {
  // The Tea Tree case: 5 new offers (Amazon + 4 third-party, us included).
  const r = estimateShare({ amazonBuyBoxPct: 95, buyBoxWinners3P: 2, offerCount: 5, amazonSelling: true });
  assert.strictEqual(r.src, 'buybox');
  assert.strictEqual(r.sellers3P, 4);
  assert.ok(Math.abs(r.share - 0.0125) < 1e-9);
});

test('no 90-day Buy Box figure yet: Amazon holding it now assumes 90%', () => {
  const r = estimateShare({ amazonHasBuyBox: true, offerCount: 5 });
  assert.strictEqual(r.src, 'guess');
  assert.ok(Math.abs(r.share - 0.1 / 4) < 1e-9);
});

test('Amazon not on the listing: third-party sellers split all of it', () => {
  const r = estimateShare({ amazonBuyBoxPct: 0, buyBoxWinners3P: 3, offerCount: 2 });
  assert.strictEqual(r.sellers3P, 3);
  assert.ok(Math.abs(r.share - 1 / 3) < 1e-9);
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

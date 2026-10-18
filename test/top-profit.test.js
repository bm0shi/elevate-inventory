const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/top-profit');

// A listing that settled at ~$95: 15% referral, $7.50 FBA fee, a refund, a promo.
const A6 = { asin: 'A', units: 100, sales: 9500, refunds: -190, promotions: -95,
  fees: -2175, feeDetail: { Commission: -1425, FBAPerUnitFulfillmentFee: -750 } };
const settled = [A6,
  { asin: 'B', units: 2, sales: 60, refunds: 0, promotions: 0, fees: -20, feeDetail: { Commission: -9, FBAPerUnitFulfillmentFee: -11 } },
  { asin: null, units: 3, sales: 40, refunds: 0, promotions: 0, fees: -10, feeDetail: { Commission: -6, FBAPerUnitFulfillmentFee: -4 } }];

test('split: referral, refunds, promos and digital services are a share of price; FBA and flat fees are per unit', () => {
  assert.deepStrictEqual(T.split(A6), { pct: -1710, unit: -750 });
  assert.deepStrictEqual(T.split({ refunds: -5, promotions: 0, fees: -3, feeDetail: { DigitalServicesFee: -1, RefundCommission: -2 } }), { pct: -8, unit: 0 });
  assert.deepStrictEqual(T.split({ fees: -7 }), { pct: 0, unit: -7 });   // no detail: per unit, as before
});

test('a price rise raises the referral fee with it (the Lavender Mint case: $95 history, sold at $112)', () => {
  const r = T.amazonRates(settled);
  assert.ok(Math.abs(r.byAsin.A.pctShare - (-1710 / 9500)) < 1e-12);   // 18% of price
  assert.strictEqual(r.byAsin.A.perUnit, -7.5);
  const e = T.estimateProfit({ asin: 'A', units: 58, sales: 58 * 112 }, r, 47.74);
  // Amazon per unit at $112: 18% × 112 + 7.50 = 27.66 (the old flat average said 24.60)
  assert.ok(Math.abs(e.amazonPerUnit - (-(0.18 * 112) - 7.5)) < 1e-9);
  assert.ok(Math.abs(e.perUnit - (112 - 27.66 - 47.74)) < 1e-9);
  assert.strictEqual(e.basis, 'listing');
});

test('the per-unit fee comes from the last 60 days when there are enough units (Amazon changes FBA fees)', () => {
  const recent = [{ asin: 'A', units: 10, sales: 1120, refunds: 0, promotions: 0, fees: -248, feeDetail: { Commission: -168, FBAPerUnitFulfillmentFee: -80 } }];
  const r = T.amazonRates(settled, recent);
  assert.strictEqual(r.byAsin.A.perUnit, -8);
  assert.strictEqual(r.byAsin.A.perUnitFrom, '60d');
  assert.strictEqual(T.amazonRates(settled, [{ asin: 'A', units: 2, sales: 224, fees: -16, feeDetail: { FBAPerUnitFulfillmentFee: -16 } }]).byAsin.A.perUnitFrom, '6mo');
});

test('few settled units borrow the store share; no cost or no fee history gives no number', () => {
  const r = T.amazonRates(settled);
  const b = T.estimateProfit({ asin: 'B', units: 4, sales: 120 }, r, 10);
  assert.strictEqual(b.basis, 'store');
  assert.ok(Math.abs(r.storeShare - ((-1710 - 750 - 20 - 10) / 9600)) < 1e-12);
  assert.strictEqual(T.estimateProfit({ asin: 'A', units: 1, sales: 26 }, r, null).missing, 'product cost');
  assert.match(T.estimateProfit({ asin: 'Z', units: 1, sales: 26 }, T.amazonRates([]), 10).missing, /no settled sales/);
});

test('worth reordering: ranked by profit per day (velocity × profit per unit); ROI shown beside it', () => {
  const rows = [
    { asin: 'fastThin', profit: 140, profitPerUnit: 2, landed: 20 },     // 70 units, $2 each → $20/day over 7 days
    { asin: 'slowFat', profit: 105, profitPerUnit: 15, landed: 30 },     // 7 units, $15 each → $15/day
    { asin: 'both', profit: 420, profitPerUnit: 12, landed: 24 },        // 35 units, $12 each → $60/day
    { asin: 'noCost', profit: null, profitPerUnit: null, landed: null },
  ];
  T.scoreRows(rows, 7);
  assert.deepStrictEqual(rows.map(r => r.scoreRank), [2, 3, 1, null]);
  assert.strictEqual(rows[2].profitPerDay, 60);
  assert.strictEqual(rows[2].roi, 0.5);
  assert.strictEqual(rows[3].profitPerDay, null);
});

test('days covered: both ends counted, never before the first saved day', () => {
  assert.strictEqual(T.daysCovered('2026-10-12', '2026-10-18', '2026-01-01'), 7);
  assert.strictEqual(T.daysCovered('2026-10-01', '2026-10-18', '2026-10-12'), 7);
  assert.strictEqual(T.daysCovered('2026-10-18', '2026-10-18', null), 1);
});

test('the period before: same length, ending the day before', () => {
  assert.deepStrictEqual(T.prevRange('2026-09-19', '2026-10-18'), { from: '2026-08-20', to: '2026-09-18', days: 30 });
  assert.deepStrictEqual(T.prevRange('2026-10-18', '2026-10-18'), { from: '2026-10-17', to: '2026-10-17', days: 1 });
});

test('rising or fading: change in profit per day against the earlier number', () => {
  assert.deepStrictEqual(T.trend(15, 10), { pct: 0.5, dir: 'up' });
  assert.deepStrictEqual(T.trend(5, 10), { pct: -0.5, dir: 'down' });
  assert.deepStrictEqual(T.trend(-5, -10), { pct: 0.5, dir: 'up' });      // a loss shrinking is better
  assert.deepStrictEqual(T.trend(8, 0), { pct: null, dir: 'new' });
  assert.deepStrictEqual(T.trend(0, 12), { pct: -1, dir: 'gone' });
  assert.strictEqual(T.trend(8, null), null);
});

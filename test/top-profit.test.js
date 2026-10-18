const test = require('node:test');
const assert = require('node:assert');
const T = require('../lib/top-profit');

const settled = [
  { asin: 'A', units: 100, sales: 2500, refunds: -50, promotions: -10, fees: -840 },   // Amazon kept 9.00/unit
  { asin: 'B', units: 2, sales: 60, refunds: 0, promotions: 0, fees: -20 },
  { asin: null, units: 3, sales: 40, refunds: 0, promotions: 0, fees: -10 },             // unlinked SKU: store rate only
];

test('rates: per listing per unit sold, and the store-wide share of sales', () => {
  const r = T.amazonRates(settled);
  assert.strictEqual(r.byAsin.A.perUnit, -9);
  assert.strictEqual(r.byAsin.B.units, 2);
  assert.ok(Math.abs(r.storeShare - (-930 / 2600)) < 1e-9);
});

test('profit: sales less Amazon per unit less landed cost; few settled units borrow the store share', () => {
  const r = T.amazonRates(settled);
  const a = T.estimateProfit({ asin: 'A', units: 10, sales: 260 }, r, 11.5);
  assert.strictEqual(a.basis, 'listing');
  assert.strictEqual(a.profit, 260 - 90 - 115);
  assert.strictEqual(a.perUnit, 5.5);
  assert.strictEqual(a.amazonPerUnit, -9);   // shown in the row's breakdown
  const b = T.estimateProfit({ asin: 'B', units: 4, sales: 120 }, r, 10);
  assert.strictEqual(b.basis, 'store');
  assert.ok(Math.abs(b.profit - (120 + 120 * (-930 / 2600) - 40)) < 1e-9);
});

test('no product cost or no fee history: no number, and why', () => {
  const r = T.amazonRates(settled);
  assert.deepStrictEqual(T.estimateProfit({ asin: 'A', units: 1, sales: 26 }, r, null).missing, 'product cost');
  assert.match(T.estimateProfit({ asin: 'Z', units: 1, sales: 26 }, T.amazonRates([]), 10).missing, /no settled sales/);
});

const test = require('node:test');
const assert = require('node:assert');
const { planTake, takenText } = require('../lib/fbm');

test('FBM: free shelf stock first, then pre-labeled, Pending Prep, Prepped & Ready (owner 11/4)', () => {
  const p = planTake(10, { free: 2, prelabel: 3, pending: [{ id: 7, qty: 1 }, { id: 8, qty: 2 }], ready: 5 });
  assert.deepStrictEqual(p, { free: 2, prelabel: 3, pending: [{ id: 7, take: 1 }, { id: 8, take: 2 }], ready: 2, short: 0, taken: 10 });
  assert.strictEqual(takenText(p), '2 from the shelf, 3 pre-labeled, 3 from Pending Prep, 2 from Prepped & Ready');
});

test('FBM: enough on the shelf leaves everything set aside alone', () => {
  const p = planTake(2, { free: 5, prelabel: 3, pending: [{ id: 1, qty: 4 }], ready: 9 });
  assert.deepStrictEqual(p, { free: 2, prelabel: 0, pending: [], ready: 0, short: 0, taken: 2 });
});

test('FBM: what isn\'t anywhere is reported short, never taken below zero', () => {
  const p = planTake(4, { free: 0, prelabel: 1, pending: [], ready: 0 });
  assert.strictEqual(p.taken, 1); assert.strictEqual(p.short, 3);
  assert.deepStrictEqual(planTake(3, { free: -2, prelabel: null, pending: [], ready: undefined }), { free: 0, prelabel: 0, pending: [], ready: 0, short: 3, taken: 0 });
});

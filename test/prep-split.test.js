const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPlan } = require('../lib/prep-split');

test('a new job over 200 is two linked halves; 200 or less stays one', () => {
  assert.deepEqual(splitPlan([], 300), { updates: [], inserts: [{ qty: 150, part: 1, group: 'new' }, { qty: 150, part: 2, group: 'new' }] });
  assert.deepEqual(splitPlan([], 301).inserts.map(i => i.qty), [151, 150]);
  assert.deepEqual(splitPlan([], 200), { updates: [], inserts: [{ qty: 200 }] });
});

test('adding to a job: splits when it passes 200, never shrinks a job someone is working', () => {
  // unclaimed 150 + 100 = 250 → 125 / 125
  assert.deepEqual(splitPlan([{ id: 7, qty: 150, claimed: false }], 100),
    { updates: [{ id: 7, qty: 125, group: 7, part: 1 }], inserts: [{ qty: 125, part: 2, group: 7 }] });
  // claimed 150 + 100: the person keeps their 150, the 100 becomes part 2
  assert.deepEqual(splitPlan([{ id: 7, qty: 150, claimed: true }], 100),
    { updates: [{ id: 7, qty: 150, group: 7, part: 1 }], inserts: [{ qty: 100, part: 2, group: 7 }] });
  // still under 200: just grows
  assert.deepEqual(splitPlan([{ id: 7, qty: 50, claimed: false }], 100), { updates: [{ id: 7, qty: 150 }], inserts: [] });
});

test('adding to a split pair rebalances free halves; a claimed half keeps its count', () => {
  const pair = (c1, c2) => [{ id: 1, qty: 150, claimed: c1, group: 1, part: 1 }, { id: 2, qty: 150, claimed: c2, group: 1, part: 2 }];
  assert.deepEqual(splitPlan(pair(false, false), 101).updates, [{ id: 1, qty: 201 }, { id: 2, qty: 200 }]);
  assert.deepEqual(splitPlan(pair(true, false), 100).updates, [{ id: 2, qty: 250 }]);
  assert.deepEqual(splitPlan(pair(true, true), 100).updates, [{ id: 1, qty: 200 }, { id: 2, qty: 200 }]);
});

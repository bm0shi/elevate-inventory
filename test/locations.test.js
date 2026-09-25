const test = require('node:test');
const assert = require('node:assert');
const { planLocations } = require('../lib/locations');

const slots = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'B-1', 'B-2', 'B-3', 'B-4'];
const loc = (r, a) => (r.assignments.find(x => x.asin === a) || {}).location;
const pos = (l) => parseInt(l.split('-')[1], 10);
const row = (l) => l.split('-')[0];

test('a duo\'s two bottles land side by side', () => {
  const r = planLocations(
    [{ asin: 'SHAMP', name: 'Tea Tree Special Shampoo' }, { asin: 'COND', name: 'Tea Tree Special Conditioner' }, { asin: 'GEL', name: 'Gel' }],
    [{ components: ['SHAMP', 'COND'] }], slots);
  const a = loc(r, 'SHAMP'), b = loc(r, 'COND');
  assert.strictEqual(row(a), row(b));
  assert.strictEqual(Math.abs(pos(a) - pos(b)), 1);
  assert.ok(loc(r, 'GEL'));
  assert.deepStrictEqual(r.unplaced, []);
});

test('an already-placed bottle is kept, and its partner goes right beside it', () => {
  const r = planLocations(
    [{ asin: 'SHAMP', name: 'Shampoo', location: 'A-6' }, { asin: 'COND', name: 'Conditioner' }],
    [{ components: ['SHAMP', 'COND'] }], slots);
  assert.strictEqual(loc(r, 'SHAMP'), undefined);            // not moved
  assert.ok(['A-5', 'A-7'].includes(loc(r, 'COND')));
});

test('a shampoo in two duos sits between both partners', () => {
  const r = planLocations(
    [{ asin: 'S', name: 'Awapuhi Shampoo' }, { asin: 'C1', name: 'Detangler' }, { asin: 'C2', name: 'Awapuhi Conditioner' }],
    [{ components: ['S', 'C1'] }, { components: ['S', 'C2'] }], slots);
  const s = pos(loc(r, 'S'));
  assert.strictEqual(Math.abs(pos(loc(r, 'C1')) - s), 1);
  assert.strictEqual(Math.abs(pos(loc(r, 'C2')) - s), 1);
});

test('a duo is not split across rows; taken spots are skipped', () => {
  const items = [{ asin: 'X', name: 'x', location: 'A-2' }, { asin: 'Y', name: 'y', location: 'A-4' }, { asin: 'Z', name: 'z', location: 'A-6' }, { asin: 'W', name: 'w', location: 'A-8' },
                 { asin: 'P', name: 'p' }, { asin: 'Q', name: 'q' }];
  const r = planLocations(items, [{ components: ['P', 'Q'] }], slots);
  assert.strictEqual(row(loc(r, 'P')), 'B');   // row A has no two free spots together
  assert.strictEqual(Math.abs(pos(loc(r, 'P')) - pos(loc(r, 'Q'))), 1);
});

test('more bottles than spots: the rest are listed as unplaced', () => {
  const items = Array.from({ length: 14 }, (_, i) => ({ asin: 'I' + i, name: 'item ' + i }));
  const r = planLocations(items, [], slots);
  assert.strictEqual(r.assignments.length, 12);
  assert.strictEqual(r.unplaced.length, 2);
});

const test = require('node:test');
const assert = require('node:assert');
const { palletStats, boxesThatFit, recommend, settings } = require('../lib/pallet');

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const box = (lb, l = 12, w = 12, h = 12, units = 0) => ({ weight_lb: lb, len: l, wid: w, hgt: h, units });
// No packaging, no safety margin: the plain 1,500 lb arithmetic.
const BARE = { palletLb: 100, boxPackLb: 0.0001, unitPackLb: 0, safetyLb: 0 };

test('an empty pallet weighs nothing; the first box brings the pallet, its cardboard and a bag per unit', () => {
  assert.strictEqual(palletStats([]).weight, 0);
  // 12 × 2.469 lb of product + 70 lb pallet & wrap + 1.5 lb box + 12 × 0.05 lb bags
  const st = palletStats([box(29.63, 12, 12, 10, 12)]);
  near(st.weight, 29.63 + 70 + 1.5 + 0.6);
  near(st.packagingLb, 72.1);
  assert.strictEqual(st.limitLb, 1450);
});

test('the owner\'s flat 100 lb under-counted a full pallet: 47 boxes of 12 is ~169 lb of packaging', () => {
  const st = palletStats(Array.from({ length: 47 }, () => box(29.3, 12, 12, 10, 12)));
  near(st.packagingLb, 70 + 47 * 1.5 + 47 * 12 * 0.05);   // 168.7
  assert.strictEqual(st.status, 'full');   // 1377 lb of product + 169 = 1546 > 1450 safe limit
});

test('height is estimated from volume over 48×40 at 85%, plus the deck; a measured height wins', () => {
  const b = Array.from({ length: 20 }, () => box(28.8));   // 20 × 1728 in³
  near(palletStats(b).height, 5 + 20 * 1728 / (48 * 40 * 0.85));
  assert.strictEqual(palletStats(b, {}, 44).height, 44);
  assert.strictEqual(palletStats(b, {}, 44).measured, true);
  // measured at 44" with 20 boxes on; 5 more added since
  const more = b.concat(Array.from({ length: 5 }, () => box(28.8)));
  near(palletStats(more, {}, { h: 44, count: 20 }).height, 44 + 5 * 1728 / (48 * 40 * 0.85));
});

test('warning at 90%, full at 100%, whichever limit is closer', () => {
  const heavy = Array.from({ length: 49 }, () => box(28, 6, 6, 6));   // small boxes: weight binds
  const st = palletStats(heavy, BARE);
  assert.strictEqual(st.limitedBy, 'weight');
  assert.strictEqual(st.status, 'near');   // 49×28 + 100 = 1472 lb (98%)
  assert.strictEqual(palletStats(heavy.concat([box(28, 6, 6, 6)]), BARE).status, 'full');   // 1500
});

test('how many more fit: weight and height both checked', () => {
  const st = palletStats(Array.from({ length: 30 }, () => box(30)), BARE);   // 1000 lb
  const f = boxesThatFit(st, box(30), BARE);
  assert.strictEqual(f.byWeight, 16);   // (1500 − 1000) / 30
  assert.strictEqual(f.byHeight, 21);   // 36.8" of 60" used
  assert.strictEqual(f.n, 16);
  assert.strictEqual(f.limitedBy, 'weight');
  // Light, tall boxes: height binds long before weight
  const tall = boxesThatFit(palletStats(Array.from({ length: 30 }, () => box(10, 12, 12, 24))), box(10, 12, 12, 24));
  assert.strictEqual(tall.limitedBy, 'height');
  assert.ok(tall.n < tall.byWeight);
  assert.strictEqual(boxesThatFit(palletStats([], BARE), box(30), BARE).byWeight, 46);   // (1500 − 100) / 30
  // Real defaults: (1450 − 70) / (30 + 1.5 + 12 × 0.05) = 42.99 → 42
  assert.strictEqual(boxesThatFit(palletStats([]), box(30, 12, 12, 12, 12)).byWeight, 42);
});

test('recommendations: finish a product before starting a half-pallet of another', () => {
  const st = palletStats(Array.from({ length: 10 }, () => box(30)));
  const r = recommend(st, [
    { asin: 'BIG', name: 'Big', boxesLeft: 40, perBox: 12, box: box(30) },
    { asin: 'FIN', name: 'Finish', boxesLeft: 3, perBox: 6, box: box(20) },
    { asin: 'DONE', name: 'Done', boxesLeft: 0, perBox: 6, box: box(20) },
  ]);
  assert.deepStrictEqual(r.map(x => x.asin), ['FIN', 'BIG']);
  assert.strictEqual(r[0].finishes, true);
  assert.strictEqual(r[0].units, 18);
  assert.ok(r[1].limitedBy);
});

test('settings: bad values fall back, 85 reads as 85%, a 0 safety margin is allowed', () => {
  assert.strictEqual(settings({ maxLb: 'x', fill: 85 }).maxLb, 1500);
  assert.strictEqual(settings({ safetyLb: 0 }).limitLb, 1500);
  assert.strictEqual(settings({ palletLb: 0 }).palletLb, 70);
  assert.strictEqual(settings({ allowanceLb: 100 }).limitLb, 1450);   // the old flat setting is ignored
  near(settings({ fill: 85 }).fill, 0.85);
});

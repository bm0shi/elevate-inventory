const test = require('node:test');
const assert = require('node:assert');
const { cubicFeet, volumeOf, calibration } = require('../lib/capacity');

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);
const dim = (l, w, h, unit = 'inches') => ({ length: { value: l, unit }, width: { value: w, unit }, height: { value: h, unit } });

test('a liter bottle box 3.5 × 3.5 × 10.2 in is about 0.072 cu ft', () => {
  near(cubicFeet({ package: dim(3.5, 3.5, 10.2) }), (3.5 * 3.5 * 10.2) / 1728);
});

test('package size wins; item size is the fallback; centimeters convert', () => {
  near(cubicFeet({ package: dim(12, 12, 12), item: dim(1, 1, 1) }), 1);
  near(cubicFeet({ item: dim(12, 12, 12) }), 1);
  near(cubicFeet({ package: dim(30.48, 30.48, 30.48, 'centimeters') }), 1);
  assert.strictEqual(cubicFeet({ package: { length: { value: 5 } } }), null);
  assert.strictEqual(cubicFeet(null), null);
});

test('volume splits standard and hazmat, and counts listings with no size', () => {
  const v = volumeOf([{ cuft: 0.1, units: 100 }, { cuft: 0.2, units: 10, hazmat: true }, { cuft: null, units: 5 }, { cuft: null, units: 0 }]);
  near(v.standard, 10); near(v.hazmat, 2); assert.strictEqual(v.missing, 1);
});

test('calibration only when the two figures are in the same ballpark', () => {
  near(calibration(1000, 1100), 1.1);
  assert.strictEqual(calibration(1000, 5000), 1);
  assert.strictEqual(calibration(0, 5000), 1);
});

const { parseAsinQty, sizeInches } = require('../lib/capacity');
test('ASIN + qty from a pasted list: FNSKUs, sizes and names skipped, a repeated ASIN added up (owner 10/30)', () => {
  const paste = `B002LTHFZ6 - 252

Paul Mitchell Super Skinny Serum Anti-Frizz Blowout Primer with Heat Protectant 5.1 fl oz
B08N9L6C93
X004D8PQEB\t352
edit
→ Ready to ship
Paul Mitchell Freeze and Shine Hairspray 33.8 fl oz
B002LTHFZ6
X0053Z6PJN\t156
edit
Paul Mitchell Freeze and Shine Hairspray 8.5 fl oz
B0009OMNPM
X004BVCLLL\t120
B004ZLZR8A - 60
B0016G0CS2 — 60`;
  const r = parseAsinQty(paste);
  assert.deepStrictEqual(r.map(x => [x.asin, x.units]), [['B002LTHFZ6', 408], ['B08N9L6C93', 352], ['B0009OMNPM', 120], ['B004ZLZR8A', 60], ['B0016G0CS2', 60]]);
  assert.deepStrictEqual(r[0].parts, [252, 156]);
});
test('size in inches says whether it is the package or the item size', () => {
  const s = sizeInches({ item: { length: { value: 2, unit: 'inches' }, width: { value: 2, unit: 'inches' }, height: { value: 8, unit: 'inches' } } });
  assert.deepStrictEqual(s, { l: 2, w: 2, h: 8, which: 'item' });
  assert.strictEqual(sizeInches({}), null);
});

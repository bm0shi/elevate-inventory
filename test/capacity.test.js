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

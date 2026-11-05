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

const { storageKind, guessAerosol, kindOf, planFit, KINDS } = require('../lib/capacity');
test('storage buckets: Amazon words, the owner\'s call first, a hazmat name guess last (owner 11/5, the aerosol refusal)', () => {
  assert.strictEqual(storageKind('Aerosol'), 'aerosol');
  assert.strictEqual(storageKind('Flammable'), 'hazmat');
  assert.strictEqual(storageKind('Standard-Size'), 'standard');
  assert.strictEqual(storageKind('Oversize'), 'standard');
  assert.strictEqual(storageKind(''), null);
  assert.deepStrictEqual(kindOf({ storage_type: 'aerosol', storage_type_amz: 'Flammable' }), { kind: 'aerosol', source: 'manual' });
  assert.deepStrictEqual(kindOf({ storage_type_amz: 'Aerosol', hazmat: false }), { kind: 'aerosol', source: 'amazon' });
  assert.deepStrictEqual(kindOf({ hazmat: true, name: 'Paul Mitchell Freeze and Shine Super Spray 10 oz' }), { kind: 'aerosol', source: 'guess' });
  assert.deepStrictEqual(kindOf({ hazmat: true, name: 'Awapuhi Wild Ginger HydroMist Spray 3.4 oz' }), { kind: 'hazmat', source: 'hazmat' });
  assert.deepStrictEqual(kindOf({ hazmat: false, name: 'Tea Tree Shampoo' }), { kind: 'standard', source: 'none' });
  assert.ok(guessAerosol('Extra-Body Sculpting Foam')); assert.ok(!guessAerosol('Leave-In Detangler Spray'));
  assert.deepStrictEqual(KINDS, ['standard', 'hazmat', 'aerosol']);
});
test('volume counts aerosol apart from flammable', () => {
  const v = volumeOf([{ cuft: 0.1, units: 100, kind: 'standard' }, { cuft: 0.2, units: 10, kind: 'hazmat' }, { cuft: 0.5, units: 4, kind: 'aerosol' }, { cuft: 0.3, units: 1, hazmat: true }]);
  near(v.standard, 10); near(v.hazmat, 2.3); near(v.aerosol, 2);
});
test('plan check: a bucket over its room is refused with the lines biggest first and how many would fit; aerosol with no limit is refused; the rest passes', () => {
  const cap = { cuft: { A: 0.1, B: 0.5, C: 0.2 }, kind: { A: 'aerosol', B: 'aerosol', C: 'standard' }, kindSrc: { A: 'guess', B: 'amazon', C: 'none' },
    used: { aerosol: 3.2, standard: 100, hazmat: 0 }, limit: { aerosol: 10, standard: 1000, hazmat: null } };
  const r = planFit([{ asin: 'A', name: 'Freeze and Shine', qty: 406 }, { asin: 'B', name: 'Big can', qty: 10 }, { asin: 'C', name: 'Shampoo', qty: 50 }], cap);
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.over[0].kind, 'aerosol');
  near(r.over[0].add, 45.6); near(r.over[0].room, 6.8);
  assert.deepStrictEqual(r.over[0].lines.map(l => l.asin), ['A', 'B']);
  assert.match(r.problems[0], /AEROSOL storage: this plan adds 45\.6 cu ft but only 6\.8 cu ft is free/);
  assert.match(r.problems[0], /Freeze and Shine ×406 \(aerosol is a guess from the name[^)]*\) = 40\.6 cu ft \(68 would fit on their own\)/);
  assert.match(r.problems[0], /Big can ×10 = 5 cu ft \(13 would fit/);
  // fits: nothing to say
  const ok = planFit([{ asin: 'B', name: 'Big can', qty: 10 }, { asin: 'C', name: 'Shampoo', qty: 50 }], cap);
  assert.deepStrictEqual(ok.problems, []);
  // aerosol units with no aerosol limit entered: refused, since that's the one Amazon refuses on
  const nl = planFit([{ asin: 'B', name: 'Big can', qty: 2 }], { ...cap, limit: { standard: 1000 } });
  assert.strictEqual(nl.noLimit[0].kind, 'aerosol'); assert.match(nl.problems[0], /aerosol limit isn't entered/);
  // a flammable or standard line with no limit set is simply not checked
  const nf = planFit([{ asin: 'C', name: 'Shampoo', qty: 50 }], { ...cap, limit: {} });
  assert.deepStrictEqual(nf.problems, []);
  // no size on file: named, not counted
  const ns = planFit([{ asin: 'Z', name: 'Mystery', qty: 5 }], cap);
  assert.strictEqual(ns.unsized.length, 1); assert.deepStrictEqual(ns.problems, []);
});

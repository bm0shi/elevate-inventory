const test = require('node:test');
const assert = require('node:assert');
const { boxBarcode, mergeItems, normShipmentId, boxWarnings, boxId, normExp, expText } = require('../lib/pack');
const { unitWeightLb } = require('../lib/capacity');

test('2D barcode text in Amazon\'s format, one entry per FNSKU', () => {
  const r = boxBarcode('fba18xrl8gv5', [{ fnsku: 'X003EH4VQ1', qty: 12 }, { fnsku: 'X0049MFSTJ', qty: 6 }, { fnsku: 'x003eh4vq1', qty: 3 }]);
  assert.strictEqual(r.text, 'AMZN,PO:FBA18XRL8GV5,FNSKU:X003EH4VQ1,QTY:15,FNSKU:X0049MFSTJ,QTY:6');
  assert.strictEqual(r.units, 21);
  assert.strictEqual(r.skus, 2);
});

test('expiration date only when it is YYMMDD', () => {
  assert.strictEqual(boxBarcode('FBA18XRL8GV5', [{ fnsku: 'X003EH4VQ1', qty: 1, exp: '270131' }]).text, 'AMZN,PO:FBA18XRL8GV5,FNSKU:X003EH4VQ1,QTY:1,EXP:270131');
  assert.strictEqual(boxBarcode('FBA18XRL8GV5', [{ fnsku: 'X003EH4VQ1', qty: 1, exp: '2027-01' }]).text, 'AMZN,PO:FBA18XRL8GV5,FNSKU:X003EH4VQ1,QTY:1');
});

test('a bad label is refused, never printed', () => {
  assert.match(boxBarcode('12345', [{ fnsku: 'X003EH4VQ1', qty: 1 }]).error, /Shipment ID/);
  assert.match(boxBarcode('FBA18XRL8GV5', []).error, /empty/);
  assert.match(boxBarcode('FBA18XRL8GV5', [{ fnsku: '009531131795', qty: 1 }]).error, /isn't an FNSKU/);
  const many = Array.from({ length: 21 }, (_, i) => ({ fnsku: 'X00000000' + String.fromCharCode(65 + i), qty: 1 }));
  assert.match(boxBarcode('FBA18XRL8GV5', many).error, /Split the box/);
});

test('zero and junk quantities are dropped when merging', () => {
  assert.deepStrictEqual(mergeItems([{ fnsku: 'X003EH4VQ1', qty: 0 }, { fnsku: '', qty: 3 }, { fnsku: 'X003EH4VQ1', qty: 'abc' }]), []);
  assert.strictEqual(normShipmentId(' fba18xrl8gv5 '), 'FBA18XRL8GV5');
});

test('box warnings: weight and size', () => {
  assert.deepStrictEqual(boxWarnings({ weight_lb: 30, len: 18, wid: 14, hgt: 12 }), []);
  assert.strictEqual(boxWarnings({ weight_lb: 52, len: 18, wid: 14, hgt: 12 }).length, 1);
  assert.strictEqual(boxWarnings({}).length, 2);
});

test('box IDs match Amazon\'s: shipment + U + 6 digits', () => {
  assert.strictEqual(boxId('FBA19R87QYJJ', 1), 'FBA19R87QYJJU000001');
  assert.strictEqual(boxId('fba19r87qyjj', 27), 'FBA19R87QYJJU000027');
  assert.strictEqual(boxId('FBA19R87QYJJ', 0), null);
});

test('expiration dates in any common format → YYMMDD; impossible dates refused', () => {
  for (const v of ['2029-09-26', '9/26/2029', '09-26-2029', '9/26/29', '290926']) assert.strictEqual(normExp(v), '290926', v);
  assert.strictEqual(normExp('2/30/2029'), null);
  assert.strictEqual(normExp(''), null);
  assert.strictEqual(expText('290926'), '09-26-2029');
});

test('unit weight from Amazon catalog data, in pounds', () => {
  assert.strictEqual(unitWeightLb({ package: { weight: { unit: 'pounds', value: 2.4 } } }), 2.4);
  assert.strictEqual(unitWeightLb({ package: { weight: { unit: 'ounces', value: 40 } } }), 2.5);
  assert.strictEqual(unitWeightLb({ item: { weight: { unit: 'kilograms', value: 1 } } }), 2.205);
  assert.strictEqual(unitWeightLb({ package: {} }), null);
});


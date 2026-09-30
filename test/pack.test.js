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

test('box numbers follow Amazon: SKUs A→Z, each SKU a block, any build order', () => {
  const { skuBlocks, blockNumbers, blockMisfits } = require('../lib/pack');
  // The pilot's SKUs (quantities made up to the same box counts).
  const items = [
    { asin: 'TT', msku: 'TT Color Cond. Liter', qty: 70 }, { asin: 'EF', msku: 'EF-LC17-YC8K', qty: 10 },
    { asin: '6G', msku: '6G-LRYZ-9L0S', qty: 24 }, { asin: 'I4', msku: 'I4-57YE-F8II', qty: 12 },
    { asin: 'O5', msku: 'O5-PB55-7VXU', qty: 6 }, { asin: '3L', msku: '3L-HCWL-B9J3', qty: 18 }, { asin: 'E7', msku: 'E7-D3O7-1IBL', qty: 30 }];
  const per = { TT: 10, EF: 10, '6G': 12, I4: 12, O5: 6, '3L': 6, E7: 10 };
  const p = skuBlocks(items, [], per);
  assert.deepStrictEqual(p.blocks.map(b => [b.msku.slice(0, 2), b.start, b.end]),
    [['3L', 1, 3], ['6G', 4, 5], ['E7', 6, 8], ['EF', 9, 9], ['I4', 10, 10], ['O5', 11, 11], ['TT', 12, 18]]);
  assert.strictEqual(p.total, 18);
  // The floor builds TT first: it gets 12-18, the numbers Amazon will give it.
  assert.deepStrictEqual(blockNumbers(p, 'TT', 7, []).nos, [12, 13, 14, 15, 16, 17, 18]);
  assert.strictEqual(blockNumbers(p, 'TT', 8, []).error, 'block_full');
  // A SKU before this one with no units per box: can't place the block yet.
  assert.deepStrictEqual(skuBlocks(items, [], { ...per, '3L': null }).missing, ['3L']);
  // Built boxes count as they are; the rest from units per box.
  const built = [{ box_no: 1, asin: '3L', units: 6 }, { box_no: 2, asin: '3L', units: 6 }];
  const p2 = skuBlocks(items, built, per);
  assert.strictEqual(p2.blocks[0].boxes, 3);
  assert.deepStrictEqual(blockNumbers(p2, '3L', 1, [1, 2]).nos, [3]);
  // Units per box changed on 3L after TT was labelled: TT's labels no longer fit.
  const p3 = skuBlocks(items, [...built, { box_no: 12, asin: 'TT', units: 10 }], { ...per, '3L': 3 });
  assert.deepStrictEqual(blockMisfits(p3, [...built, { box_no: 12, asin: 'TT', units: 10 }]), [12]);
});

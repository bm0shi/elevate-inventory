const test = require('node:test');
const assert = require('node:assert');
const ib = require('../lib/inbound');

test('boxes are planned from saved units per box; the last box can be partial; weight counts packaging', () => {
  const r = ib.planBoxes([{ msku: 'A', qty: 30, perBox: 12, len: 12, wid: 12, hgt: 10, unitLb: 2.469, exp: '290914' }, { msku: 'B', qty: 5 }], { boxPackLb: 1.5, unitPackLb: 0.05 });
  assert.deepStrictEqual(r.boxes.map(b => b.items[0].qty), [12, 12, 6]);
  assert.strictEqual(r.boxes[0].weight_lb, Math.round((12 * 2.469 + 1.5 + 0.6) * 100) / 100);
  assert.strictEqual(r.boxes[2].items[0].exp, '290914');
  assert.match(r.problems[0], /B: needs units per box/);
});

test('source address: Amazon needs a phone; missing fields are named', () => {
  const from = { name: 'Beauty is', line1: '4153 W Thunderbird Rd', city: 'Phoenix', state: 'AZ', zip: '85029', country: 'US' };
  assert.match(ib.sourceAddress(from, {}).error, /phone/);
  const a = ib.sourceAddress(from, { phone: '(602) 555-0100', email: 'x@y.com' }).address;
  assert.strictEqual(a.phoneNumber, '6025550100');
  assert.strictEqual(a.stateOrProvinceCode, 'AZ');
  assert.strictEqual(a.email, 'x@y.com');
});

test('plan body merges repeated SKUs and drops empty lines', () => {
  const r = ib.planBody({ name: 'Test', marketplaceId: 'ATVPDKIKX0DER', source: { x: 1 },
    items: [{ msku: 'A', qty: 12 }, { msku: 'A', qty: 12 }, { msku: 'B', qty: 0 }, { msku: 'C', qty: 6, expiration: '2029-09-14' }] });
  assert.deepStrictEqual(r.body.items, [
    { msku: 'A', quantity: 24, labelOwner: 'SELLER', prepOwner: 'NONE' },
    { msku: 'C', quantity: 6, labelOwner: 'SELLER', prepOwner: 'NONE', expiration: '2029-09-14' }]);
  assert.match(ib.planBody({ items: [] }).error, /at least one/);
});

test('packing body: identical boxes collapse to a quantity; mixed-group and unsized boxes are refused', () => {
  const groups = [{ packingGroupId: 'pg1', mskus: ['A', 'B'] }, { packingGroupId: 'pg2', mskus: ['C'] }];
  const box = (n, items, w = 29.63) => ({ box_no: n, items, weight_lb: w, len: 12, wid: 12, hgt: 10 });
  const r = ib.packingBody(groups, [
    box(1, [{ msku: 'A', qty: 12, exp: '290914' }]), box(2, [{ msku: 'A', qty: 12, exp: '290914' }]),
    box(3, [{ msku: 'C', qty: 6 }]), box(4, [{ msku: 'A', qty: 2 }, { msku: 'C', qty: 2 }]), box(5, [{ msku: 'B', qty: 1 }], 0)]);
  assert.strictEqual(r.body.packageGroupings.length, 2);
  const g1 = r.body.packageGroupings.find(g => g.packingGroupId === 'pg1');
  assert.strictEqual(g1.boxes.length, 1);
  assert.strictEqual(g1.boxes[0].quantity, 2);
  assert.strictEqual(g1.boxes[0].items[0].expiration, '2029-09-14');
  assert.deepStrictEqual(g1.boxes[0].weight, { value: 29.63, unit: 'LB' });
  assert.strictEqual(r.problems.length, 2);
  assert.match(r.problems[0], /Box 4/);
  assert.match(r.problems[1], /Box 5/);
});

test('boxed vs plan: every SKU must be boxed exactly', () => {
  const plan = [{ msku: 'A', qty: 24 }, { msku: 'C', qty: 6 }];
  assert.strictEqual(ib.boxedVsPlan(plan, [{ items: [{ msku: 'A', qty: 24 }] }, { items: [{ msku: 'C', qty: 6 }] }]).ok, true);
  const r = ib.boxedVsPlan(plan, [{ items: [{ msku: 'A', qty: 12 }, { msku: 'X', qty: 1 }] }]);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.rows.find(x => x.msku === 'X'), { msku: 'X', planned: 0, boxed: 1 });
});

test('placement options: fee net of discounts, cheapest first', () => {
  const s = ib.placementSummary([
    { placementOptionId: 'p2', shipmentIds: ['s1', 's2', 's3'], fees: [{ value: { amount: 0 } }], discounts: [] },
    { placementOptionId: 'p1', shipmentIds: ['s1'], fees: [{ value: { amount: 412.5 } }], discounts: [{ value: { amount: 12.5 } }] }]);
  assert.deepStrictEqual(s.map(x => [x.placementOptionId, x.fee, x.shipments]), [['p2', 0, 3], ['p1', 400, 1]]);
});

test('palletize: boxes stack by the floor\'s limits; pallets come out rounded up', () => {
  const box = { weight: { value: 31.7, unit: 'LB' }, dimensions: { length: 12, width: 12, height: 10, unitOfMeasurement: 'IN' }, items: [{ msku: 'A', quantity: 12 }], quantity: 60 };
  const p = ib.palletize([box], {});
  assert.strictEqual(p.reduce((t, x) => t + x.boxes, 0), 60);
  assert.ok(p.length >= 2, 'one pallet can\'t hold 60 × 31.7 lb under 1,450 lb');
  assert.ok(p.every(x => x.weight <= 1450 && x.height <= 60));
  const body = ib.palletsBody(p, false);
  assert.strictEqual(body[0].stackability, 'NON_STACKABLE');
  assert.deepStrictEqual(body[0].dimensions, { length: 48, width: 40, height: p[0].height, unitOfMeasurement: 'IN' });
});

test('freight options: partnered carrier first, then cheapest', () => {
  const s = ib.transportSummary([
    { transportationOptionId: 't1', shipmentId: 's', shippingSolution: 'USE_YOUR_OWN_CARRIER', shippingMode: 'FREIGHT_LTL', quote: { cost: { amount: 100 } } },
    { transportationOptionId: 't2', shipmentId: 's', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'FREIGHT_LTL', carrier: { name: 'Estes' }, quote: { cost: { amount: 480.114 } } },
    { transportationOptionId: 't3', shipmentId: 's', shippingSolution: 'AMAZON_PARTNERED_CARRIER', shippingMode: 'FREIGHT_LTL', carrier: { name: 'XPO' }, quote: { cost: { amount: 455 } } }]);
  assert.deepStrictEqual(s.map(x => x.transportationOptionId), ['t3', 't2', 't1']);
  assert.strictEqual(s[1].cost, 480.11);
});

test('Amazon\'s box numbers: the floor gets the numbers Amazon gave that product', () => {
  const map = ib.amazonBoxMap([
    { boxId: 'FBA19R908TWYU000002', items: [{ msku: 'SKU-B', quantity: 6 }] },
    { boxId: 'FBA19R908TWYU000001', items: [{ msku: 'SKU-A', quantity: 12 }] },
    { boxId: 'FBA19R908TWYU000003', items: [{ msku: 'SKU-A', quantity: 12 }] },
    { boxId: 'FBA19R908TWYU000004', items: [{ msku: 'SKU-A', quantity: 6 }] }], { 'SKU-A': 'A', 'SKU-B': 'B' });
  assert.deepStrictEqual(map.map(b => b.box_no), [1, 2, 3, 4]);
  assert.deepStrictEqual(ib.pickAmazonBoxes(map, 'A', 12, 2, []), { boxes: [1, 3], short: 0 });
  assert.deepStrictEqual(ib.pickAmazonBoxes(map, 'A', 12, 2, [1]), { boxes: [3], short: 1 });
  assert.deepStrictEqual(ib.pickAmazonBoxes(map, 'A', 6, 1, []), { boxes: [4], short: 0 });   // the partial box
  assert.deepStrictEqual(ib.pickAmazonBoxes(map, 'B', 12, 1, []), { boxes: [], short: 1 });  // wrong units per box
});

test('palletize doesn\'t count the box packaging twice (planned weights already include it)', () => {
  const planned = ib.planBoxes([{ msku: 'A', qty: 24, perBox: 12, len: 12, wid: 12, hgt: 10, unitLb: 2.5 }], { boxPackLb: 1.5, unitPackLb: 0.05 }).boxes;
  const p = ib.palletize(planned.map(b => ({ weight: { value: b.weight_lb, unit: 'LB' }, dimensions: { length: 12, width: 12, height: 10 }, items: [{ msku: 'A', quantity: 12 }] })), {});
  assert.strictEqual(p[0].weight, Math.ceil(24 * 2.5 + 2 * 1.5 + 24 * 0.05 + 70));
});

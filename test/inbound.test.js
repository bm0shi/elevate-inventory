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

test('pack later: built boxes go to Amazon one by one in box-number order, packaging added to the weight', () => {
  const boxes = [
    { box_no: 2, items: [{ asin: 'B', msku: 'SKU-B', qty: 6 }], weight_lb: 12, len: 12, wid: 10, hgt: 8 },
    { box_no: 1, items: [{ asin: 'A', msku: 'SKU-A', qty: 12, exp: '290926' }], weight_lb: 30, len: 12, wid: 10, hgt: 8 },
    { box_no: 3, items: [{ asin: 'A', msku: 'SKU-A', qty: 12 }], weight_lb: 30, len: 12, wid: 10, hgt: 8 }];
  const r = ib.shipmentBoxesBody('sh1', boxes, { boxPackLb: 1.5, unitPackLb: 0.05 });
  assert.deepStrictEqual(r.problems, []);
  const g = r.body.packageGroupings;
  assert.strictEqual(g.length, 1); assert.strictEqual(g[0].shipmentId, 'sh1');
  assert.deepStrictEqual(g[0].boxes.map(b => [b.weight.value, b.quantity]), [[30 + 1.5 + 0.6, 1], [12 + 1.5 + 0.3, 1], [30 + 1.5 + 0.6, 1]]);
});

test('pack later: a gap in box numbers or a box with no size stops the send', () => {
  const r = ib.shipmentBoxesBody('sh1', [
    { box_no: 1, items: [{ msku: 'A', qty: 1 }], weight_lb: 1, len: 1, wid: 1, hgt: 1 },
    { box_no: 3, items: [{ msku: 'A', qty: 1 }], weight_lb: 1, len: 0, wid: 1, hgt: 1 }], {});
  assert.ok(r.problems.some(p => /no gaps/.test(p)));
  assert.ok(r.problems.some(p => /Box 3 has no weight or size/.test(p)));
  assert.strictEqual(r.body, undefined);
});

test('pack later: Amazon\'s box numbers checked against the labels', () => {
  const ours = [{ box_no: 1, items: [{ msku: 'A', qty: 12 }] }, { box_no: 2, items: [{ msku: 'B', qty: 6 }] }];
  const amzOk = [{ boxId: 'FBA1U000001', items: [{ msku: 'A', quantity: 12 }] }, { boxId: 'FBA1U000002', items: [{ msku: 'B', quantity: 6 }] }];
  assert.strictEqual(ib.checkBoxIds(ours, amzOk).ok, true);
  const swapped = [{ boxId: 'FBA1U000001', items: [{ msku: 'B', quantity: 6 }] }, { boxId: 'FBA1U000002', items: [{ msku: 'A', quantity: 12 }] }, { boxId: 'FBA1U000003', items: [] }];
  assert.deepStrictEqual(ib.checkBoxIds(ours, swapped), { ok: false, wrong: [1, 2], missing: [], extra: [3] });
});

test('2D barcode: each box goes with its size and weight only; Amazon reads the contents off the label', () => {
  const bx = { box_no: 1, items: [{ msku: 'A', qty: 10 }], weight_lb: 24, len: 12, wid: 12, hgt: 10 };
  const box = ib.shipmentBoxesBody('sh1', [bx], {}).body.packageGroupings[0].boxes[0];
  assert.strictEqual(box.contentInformationSource, 'BARCODE_2D');
  assert.strictEqual(box.items, undefined);   // Amazon refuses an item list with BARCODE_2D
});

test('pack later: the floor\'s pallets become the freight pallets', () => {
  const box = (n, pal) => ({ box_no: n, pallet_no: pal, items: [{ qty: 10 }], weight_lb: 20, len: 12, wid: 12, hgt: 12 });
  const p = ib.floorPallets([box(1, 1), box(2, 1), box(3, 2)], {}, { 2: { h: 30, count: 1 } });
  assert.deepStrictEqual(p.map(x => [x.pallet, x.boxes]), [[1, 2], [2, 1]]);
  assert.strictEqual(p[0].weight, Math.ceil(2 * (20 + 1.5 + 0.5) + 70));
  assert.strictEqual(p[1].height, 30);   // tape-measured
});

test('prep owner: Amazon\'s refusal says which products need prep by seller (first real plan)', () => {
  const msg = 'Amazon 400 on POST /inboundPlans: {"errors":[{"code":"BadRequest","message":"ERROR: 1S-RXVQ-W2YL requires prepOwner but NONE was assigned. Accepted values: [AMAZON, SELLER]","details":""},'
    + '{"code":"BadRequest","message":"ERROR: TTS 16.9 does not require prepOwner but SELLER was assigned. Accepted values: [NONE]","details":""}]}';
  assert.deepStrictEqual(ib.ownerFixes(msg, ['1S-RXVQ-W2YL', 'TTS 16.9', 'WP-N569-M1HX']),
    { '1S-RXVQ-W2YL': { prepOwner: 'SELLER' }, 'TTS 16.9': { prepOwner: 'NONE' } });
  assert.deepStrictEqual(ib.ownerFixes('Amazon 500: timeout', ['A']), {});
  const body = ib.planBody({ items: [{ msku: 'A', qty: 1, prepOwner: 'SELLER' }, { msku: 'B', qty: 2 }], source: {}, marketplaceId: 'M', prepOwner: 'NONE' }).body;
  assert.deepStrictEqual(body.items.map(i => i.prepOwner), ['SELLER', 'NONE']);
});

test('prep: Amazon\'s prep data decides — prep needed → SELLER (we do it), none → NONE', () => {
  const o = ib.ownersFromPrepDetails([
    { msku: 'A', prepCategory: 'FRAGILE', prepTypes: ['ITEM_BUBBLEWRAP'], prepOwnerConstraint: 'AMAZON_OR_SELLER' },
    { msku: 'B', prepCategory: 'NONE', prepTypes: ['ITEM_NO_PREP'] },
    { msku: 'C', prepCategory: 'UNKNOWN', prepTypes: [] },
    { msku: 'D', prepTypes: ['ITEM_POLYBAGGING'], prepOwnerConstraint: 'AMAZON_ONLY', labelOwnerConstraint: 'AMAZON_ONLY' }]);
  assert.deepStrictEqual(o, { A: { prepOwner: 'SELLER' }, B: { prepOwner: 'NONE' }, D: { prepOwner: 'AMAZON', labelOwner: 'AMAZON' } });
});

test('expiration: Amazon\'s "Expiration date required" names the SKUs (first real plan)', () => {
  const msg = "Amazon refused it — FBA_INB_0180: ERROR: Expiration date required (There's an input error with the resource 'WP-N569-M1HX'.) · FBA_INB_0180: ERROR: Expiration date required (There's an input error with the resource '1S-RXVQ-W2YL'.)";
  assert.deepStrictEqual(ib.expiryNeeded(msg, ['1S-RXVQ-W2YL', 'WP-N569-M1HX', 'OTHER']), ['1S-RXVQ-W2YL', 'WP-N569-M1HX']);
  assert.deepStrictEqual(ib.expiryNeeded('Amazon 500', ['A']), []);
});

test('freight estimate: pallets guessed from saved cases, or Amazon package size in a standard carton', () => {
  const e = ib.estimatePallets([
    { msku: 'A', units: 60, unitLb: 2, perBox: 6, len: 12, wid: 10, hgt: 8 },        // 10 saved cases
    { msku: 'B', units: 100, unitLb: 1, cuft: 0.035 },                                // 1.75 cu ft × 80% / 0.035 = 40 per carton → 3
    { msku: 'C', units: 5 }]);                                                        // no weight: can't estimate
  assert.deepStrictEqual(e.missing, ['C']);
  assert.strictEqual(e.pallets.length, 1);
  assert.strictEqual(e.pallets[0].boxes, 13);
  assert.strictEqual(e.pallets[0].weight, Math.ceil(60 * 2 + 100 + 13 * 1.5 + 160 * 0.05 + 70));
  // Heavy enough for two pallets under the 1,450 lb safe limit.
  assert.strictEqual(ib.estimatePallets([{ msku: 'H', units: 1200, unitLb: 2, perBox: 12, len: 12, wid: 10, hgt: 8 }]).pallets.length, 2);
});

test('freight options: the same carrier listed many times shows once, at its lowest price', () => {
  const o = (id, name, amt, exp, mode = 'FREIGHT_LTL') => ({ transportationOptionId: id, shipmentId: 'sh1', carrier: { name }, shippingMode: mode, shippingSolution: 'AMAZON_PARTNERED_CARRIER', quote: { cost: { amount: amt, code: 'USD' }, expiration: exp } });
  const list = [o('a1', 'CENTRAL', 144.59, '2026-09-29T10:00Z'), o('a2', 'CENTRAL', 144.59, '2026-09-29T11:00Z'), o('b1', 'ESTES', 204.38, 'x'),
    o('c1', 'Amazon Freight', 275.10, 'x'), o('c2', 'Amazon Freight', 271.55, 'x'), o('d1', 'FLOCK', 584.39, 'x', 'FREIGHT_FTL_PALLET')];
  const s = ib.transportSummary(list);
  assert.deepStrictEqual(s.map(x => [x.carrier, x.cost]), [['CENTRAL', 144.59], ['ESTES', 204.38], ['Amazon Freight', 271.55], ['FLOCK', 584.39]]);
  assert.strictEqual(s[0].transportationOptionId, 'a2');   // equal price: the one quoted last
});

test('freight options: each pickup day is kept, soonest pickup first', () => {
  const o = (id, name, amt, day) => ({ transportationOptionId: id, shipmentId: 'sh1', carrier: { name }, shippingMode: 'FREIGHT_LTL', shippingSolution: 'AMAZON_PARTNERED_CARRIER',
    quote: { cost: { amount: amt, code: 'USD' } }, ...(day ? { carrierAppointment: { startTime: day + 'T15:00:00Z', endTime: day + 'T23:00:00Z' } } : {}) });
  // The pilot: the cheaper CENTRAL quote picked up 6 days out and hid the sooner one
  const s = ib.transportSummary([o('late', 'CENTRAL', 141.72, '2026-10-05'), o('soon', 'CENTRAL', 150.10, '2026-10-01'), o('soon2', 'CENTRAL', 155, '2026-10-01'), o('x', 'ESTES', 120, null)]);
  assert.deepStrictEqual(s.map(x => x.transportationOptionId), ['soon', 'late', 'x']);
  assert.deepStrictEqual(s[0].pickup, { start: '2026-10-01T15:00:00Z', end: '2026-10-01T23:00:00Z' });
  assert.strictEqual(s[2].pickup, null);
});

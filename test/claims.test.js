const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/claims');

const DAY = 86400000, NOW = Date.UTC(2026, 9, 12);
const iso = d => new Date(NOW - d * DAY).toISOString();

test('reimbursements report: rows parsed, a repeated row counted once', () => {
  const h = 'approval-date\treimbursement-id\tcase-id\tamazon-order-id\treason\tsku\tfnsku\tasin\tproduct-name\tcondition\tcurrency-unit\tamount-per-unit\tamount-total\tquantity-reimbursed-cash\tquantity-reimbursed-inventory\tquantity-reimbursed-total';
  const row = '2026-09-01T10:00:00+00:00\t1234\t\t\tLost_Inbound\tSKU-A\tX001\tB001\tShampoo\tSellable\tUSD\t9.50\t19.00\t2\t0\t2';
  const r = C.parseReimbursements([h + '\n' + row + '\n' + row]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].reason, r[0].sku, r[0].qty, r[0].perUnit, r[0].total], ['Lost_Inbound', 'SKU-A', 2, 9.5, 19]);
});

test('refund orders: item refunds only, by order and SKU', () => {
  const p = { FinancialEvents: { RefundEventList: [
    { AmazonOrderId: '111-1', PostedDate: iso(60), ShipmentItemAdjustmentList: [
      { SellerSKU: 'SKU-A', QuantityShipped: 1, ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: -21 } }, { ChargeType: 'Tax', ChargeAmount: { CurrencyAmount: -1.5 } }] }] },
    { AmazonOrderId: '111-2', PostedDate: iso(60), ShipmentItemAdjustmentList: [
      { SellerSKU: 'SKU-A', ItemChargeAdjustmentList: [{ ChargeType: 'ShippingCharge', ChargeAmount: { CurrencyAmount: -5 } }] }] },
  ] } };
  const r = C.refundOrders([p]);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].order, r[0].sku, r[0].qty, r[0].amount], ['111-1', 'SKU-A', 1, -21]);
});

test('inbound: a closed shipment short 5 is owed 5; what Amazon paid for the SKU later comes off', () => {
  const recon = [
    { shipment_id: 'FBA1', sku: 'SKU-A', shipped: 100, received: 95, closed: true, done_at: iso(20), created_at: iso(40) },
    { shipment_id: 'FBA2', sku: 'SKU-A', shipped: 50, received: 48, closed: true, done_at: iso(10), created_at: iso(25) },
    { shipment_id: 'FBA3', sku: 'SKU-B', shipped: 10, received: 4, closed: false, done_at: iso(10) },   // still receiving
    { shipment_id: 'FBA4', sku: 'SKU-B', shipped: 10, received: 9, closed: true, done_at: iso(2) },     // too fresh
  ];
  const reimb = [{ reason: 'Lost_Inbound', sku: 'SKU-A', qty: 3, ts: NOW - 5 * DAY }];
  const r = C.inboundClaims(recon, reimb, { now: NOW });
  assert.deepStrictEqual(r.map(x => [x.shipment_id, x.missing, x.reimbursed, x.owed]), [['FBA1', 5, 3, 2], ['FBA2', 2, 0, 2]]);
});

test('inbound: a payment from before the shipment existed is not counted against it', () => {
  const recon = [{ shipment_id: 'FBA9', sku: 'S', shipped: 10, received: 8, closed: true, done_at: iso(20), created_at: iso(30) }];
  const r = C.inboundClaims(recon, [{ reason: 'Lost_Inbound', sku: 'S', qty: 2, ts: NOW - 100 * DAY }], { now: NOW });
  assert.strictEqual(r[0].owed, 2);
});

test('refund: no return after 45 days is owed; a return or a reimbursement clears it; too recent waits', () => {
  const refunds = [
    { order: 'A', sku: 'S', qty: 1, ts: NOW - 60 * DAY, amount: -20 },
    { order: 'B', sku: 'S', qty: 1, ts: NOW - 60 * DAY, amount: -20 },
    { order: 'C', sku: 'S', qty: 1, ts: NOW - 60 * DAY, amount: -20 },
    { order: 'D', sku: 'S', qty: 1, ts: NOW - 10 * DAY, amount: -20 },
  ];
  const returns = [{ order: 'B', sku: 'S', qty: 1 }];
  const reimb = [{ order: 'C', reason: 'CustomerReturn', qty: 1 }];
  const r = C.refundClaims(refunds, returns, reimb, { now: NOW });
  assert.deepStrictEqual(r.map(x => [x.order, x.owed]), [['A', 1]]);
});

test('value: past reimbursements for the SKU first, else the unit cost', () => {
  assert.strictEqual(C.unitValue('S', [{ sku: 'S', qty: 1, perUnit: 8 }, { sku: 'S', qty: 2, perUnit: 10 }], 6).value, 9);
  assert.strictEqual(C.unitValue('S', [], 6).value, 6);
  assert.strictEqual(C.unitValue('S', [], null).value, null);
});

test('case text: names the shipment, SKU, counts and the invoice as proof', () => {
  const t = C.caseText({ type: 'inbound', shipment_id: 'FBA1', sku: 'SKU-A', fnsku: 'X001', asin: 'B001', shipped: 100, received: 95, missing: 5, reimbursed: 0, owed: 5 },
    { order_number: '262023702', invoice_date: '9/25/26', qty: 120 });
  assert.match(t, /FBA1/); assert.match(t, /Shipped: 100\s+Received: 95\s+Missing: 5/); assert.match(t, /invoice #262023702/);
  assert.match(C.caseText({ type: 'refund', order: '111-1', sku: 'S', refunded: 1, returned: 0, owed: 1, since: NOW }), /nothing came back/);
});

test('groups: one case per shipment and per order; status and totals add up; one-claim groups keep their text', () => {
  const claims = [
    { type: 'inbound', key: 'in:FBA1:A', shipment_id: 'FBA1', sku: 'A', shipped: 10, received: 8, missing: 2, owed: 2, value: 20, status: 'open', since: 5 },
    { type: 'inbound', key: 'in:FBA1:B', shipment_id: 'FBA1', sku: 'B', shipped: 5, received: 4, missing: 1, reimbursed: 0, owed: 1, value: 9, status: 'filed', caseId: '123', since: 5 },
    { type: 'refund', key: 'rf:111:A', order: '111', sku: 'A', refunded: 1, returned: 0, owed: 1, value: 10, status: 'open', since: 1 },
  ];
  const g = C.groupClaims(claims, { });
  assert.strictEqual(g.length, 2);
  const s = g.find(x => x.gkey === 'in:FBA1');
  assert.deepStrictEqual([s.owed, s.value, s.status, s.caseId, s.keys.length], [3, 29, 'open', '123', 2]);
  assert.match(s.text, /missing for 2 products/); assert.match(s.text, /Total: 3 units/);
  const r = g.find(x => x.gkey === 'rf:111');
  assert.strictEqual(r.text, C.caseText(claims[2], null));
});

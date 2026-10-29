const test = require('node:test');
const assert = require('node:assert');
const { aggregateFinancialEvents } = require('../lib/finevents');

const $ = v => ({ CurrencyCode: 'USD', CurrencyAmount: v });
test('financial events: refunds without tax, fees from shipments and refund adjustments, by Pacific day', () => {
  const page1 = { FinancialEvents: {
    ShipmentEventList: [{ PostedDate: '2026-10-08T20:00:00Z', ShipmentItemList: [{ ItemFeeList: [{ FeeType: 'Commission', FeeAmount: $(-4.5) }, { FeeType: 'FBAPerUnitFulfillmentFee', FeeAmount: $(-5.2) }] }] }],
    RefundEventList: [{ PostedDate: '2026-10-09T06:30:00Z',   // Oct 8, 23:30 Pacific
      ShipmentItemAdjustmentList: [{ QuantityShipped: 1,
        ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: $(-30) }, { ChargeType: 'Tax', ChargeAmount: $(-2.4) }],
        ItemFeeAdjustmentList: [{ FeeType: 'Commission', FeeAmount: $(4.5) }, { FeeType: 'RefundCommission', FeeAmount: $(-0.9) }] }] }] } };
  const page2 = { FinancialEvents: { RefundEventList: [{ PostedDate: '2026-10-09T18:00:00Z',
    ShipmentItemAdjustmentList: [{ QuantityShipped: 2, ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: $(-60) }] }] }] } };
  const d = aggregateFinancialEvents([page1, page2], '2026-10-07', '2026-10-09');
  assert.deepStrictEqual(d['2026-10-07'], { refunds: 0, refundUnits: 0, fees: 0 });
  assert.deepStrictEqual(d['2026-10-08'], { refunds: -30, refundUnits: 1, fees: -6.1 });
  assert.deepStrictEqual(d['2026-10-09'], { refunds: -60, refundUnits: 2, fees: 0 });
});

const { eventLines } = require('../lib/finevents');
const { isPassThroughTax } = require('../lib/settlement-parse');
test('financial events as settlement-style lines: sales, fees, promos, tax apart, refunds with negative units', () => {
  const page = { FinancialEvents: {
    ShipmentEventList: [{ AmazonOrderId: '111-1', PostedDate: '2026-10-26T03:00:00Z', ShipmentItemList: [{ SellerSKU: 'SKU-A', QuantityShipped: 2,
      ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: $(40) }, { ChargeType: 'Tax', ChargeAmount: $(3.2) }, { ChargeType: 'ShippingCharge', ChargeAmount: $(0) }],
      ItemFeeList: [{ FeeType: 'Commission', FeeAmount: $(-6) }],
      PromotionList: [{ PromotionType: 'PromotionMetaDataDefinitionValue', PromotionAmount: $(-2) }],
      ItemTaxWithheldList: [{ TaxesWithheld: [{ ChargeType: 'MarketplaceFacilitatorTax-Principal', ChargeAmount: $(-3.2) }] }] }] }],
    RefundEventList: [{ AmazonOrderId: '111-2', PostedDate: '2026-10-27T12:00:00Z', ShipmentItemAdjustmentList: [{ SellerSKU: 'SKU-B', QuantityShipped: 1,
      ItemChargeAdjustmentList: [{ ChargeType: 'Principal', ChargeAmount: $(-25) }] }] }],
    AdjustmentEventList: [{ AdjustmentType: 'WAREHOUSE_DAMAGE', PostedDate: '2026-10-27T12:00:00Z', AdjustmentAmount: $(11.5) }],
    ServiceFeeEventList: [{ FeeList: [{ FeeType: 'Subscription', FeeAmount: $(-39.99) }] }] } };
  const L = eventLines([page]);
  const prin = L.find(x => x.amount_description === 'Principal' && x.kind === 'order');
  assert.deepStrictEqual([prin.day, prin.order_id, prin.sku, prin.amount_type, prin.amount, prin.quantity, prin.transaction_type],
    ['2026-10-26', '111-1', 'SKU-A', 'ItemPrice', 40, 2, 'Order']);
  assert.ok(!L.some(x => x.amount_description === 'ShippingCharge'), '$0 lines are skipped');
  // tax both ways is pass-through under the P&L's own rule
  for (const x of L.filter(x => /tax/i.test(x.amount_description))) assert.ok(isPassThroughTax(x.amount_type, x.amount_description), x.amount_description);
  assert.strictEqual(L.find(x => x.amount_type === 'Promotion').amount, -2);
  const ref = L.find(x => x.kind === 'refund');
  assert.deepStrictEqual([ref.amount, ref.quantity, ref.transaction_type], [-25, -1, 'Refund']);
  const adj = L.find(x => x.kind === 'other');
  assert.ok(/reimburs/i.test(adj.amount_description) && adj.order_id === null && adj.amount === 11.5);
  assert.ok(!L.some(x => /Subscription/.test(x.amount_description)), 'undated service fees wait for the settlement');
});

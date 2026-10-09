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

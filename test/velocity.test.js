const test = require('node:test');
const assert = require('node:assert');
const { parseOrdersReport, unitsFor } = require('../lib/velocity');

const H = ['amazon-order-id', 'purchase-date', 'item-status', 'sku', 'asin', 'quantity'].join('\t');
const row = (...c) => c.join('\t');

test('an ASIN selling under a SKU other than the catalog one still counts', () => {
  const body = [H,
    row('1', '2026-10-01T10:00:00Z', 'Shipped', 'CATALOG-SKU', 'B000TEST01', '2'),
    row('2', '2026-10-02T10:00:00Z', 'Shipped', 'amzn.gr.OTHER', 'B000TEST01', '5'),
    row('3', '2026-10-02T10:00:00Z', 'Cancelled', 'CATALOG-SKU', 'B000TEST01', '9'),
    row('4', '2026-08-01T10:00:00Z', 'Shipped', 'CATALOG-SKU', 'B000TEST01', '4'), // placed before the window
  ].join('\n');
  const s = parseOrdersReport(body, Date.parse('2026-09-01T00:00:00Z'));
  assert.deepStrictEqual(s.bySku, { 'CATALOG-SKU': 2, 'amzn.gr.OTHER': 5 });
  assert.deepStrictEqual(s.byAsin, { B000TEST01: 7 });
  // the case behind the 0s on the attack list: catalog SKU alone said 2 (or 0)
  assert.strictEqual(unitsFor(s, 'B000TEST01', 'CATALOG-SKU'), 7);
  assert.strictEqual(unitsFor(s, 'B000TEST01', 'NEVER-SOLD-SKU'), 7);
  assert.strictEqual(unitsFor(s, 'B000NOSALE', 'X'), 0);
});

test('a report without an asin column falls back to the SKU', () => {
  const body = ['sku\tquantity\titem-status', 'A\t3\tShipped', 'A\t1\tShipped'].join('\n');
  const s = parseOrdersReport(body, null);
  assert.strictEqual(unitsFor(s, 'B0X', 'A'), 4);
  assert.deepStrictEqual(parseOrdersReport('', 0), { bySku: {}, byAsin: {} });
});

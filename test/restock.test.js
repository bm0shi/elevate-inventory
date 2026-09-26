const test = require('node:test');
const assert = require('node:assert');
const { parseRestockReport } = require('../lib/restock');

const H = ['Country', 'Product Name', 'FNSKU', 'Merchant SKU', 'ASIN', 'Condition', 'Units Sold Last 30 Days',
  'Total Days of Supply (including units from open shipments)', 'Alert', 'Recommended replenishment qty', 'Recommended ship date', 'Recommended action'].join('\t');

test('reads Amazon\'s number per SKU by header name', () => {
  const r = parseRestockReport(H + '\n' + ['US', 'Tea Tree Shampoo', 'X001', 'TT-SH', 'B00A', 'New', '42', '12.5', 'out_of_stock', '120', '2026-10-01', 'Create shipping plan'].join('\t'));
  const row = r.bySku['TT-SH'];
  assert.strictEqual(row.asin, 'B00A');
  assert.strictEqual(row.qty, 120);
  assert.strictEqual(row.daysSupply, 12.5);
  assert.strictEqual(row.sold30, 42);
  assert.strictEqual(row.alert, 'out_of_stock');
  assert.strictEqual(row.shipDate, '2026-10-01');
});

test('two SKUs on one ASIN: quantities summed, earliest ship date kept', () => {
  const line = (sku, q, d) => ['US', 'x', 'X', sku, 'B00B', 'New', '', '', '', q, d, ''].join('\t');
  const r = parseRestockReport(H + '\r\n' + line('A', '10', '2026-10-09') + '\r\n' + line('B', '5', '2026-10-02') + '\r\n');
  assert.strictEqual(r.byAsin.B00B.qty, 15);
  assert.strictEqual(r.byAsin.B00B.shipDate, '2026-10-02');
  assert.strictEqual(r.bySku.A.qty, 10);
});

test('blank quantity reads as 0; a report without the quantity column is an error, not empty', () => {
  const r = parseRestockReport(H + '\n' + ['US', 'x', 'X', 'S', 'B1', 'New', '', '', '', '', '', ''].join('\t'));
  assert.strictEqual(r.bySku.S.qty, 0);
  assert.throws(() => parseRestockReport('sku\tasin\nS\tB1'), /columns not found/);
  assert.deepStrictEqual(parseRestockReport(''), { bySku: {}, byAsin: {} });
});

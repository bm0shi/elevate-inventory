const test = require('node:test');
const assert = require('node:assert');
const { parseOrdersReport, reportWindows, unitsFor } = require('../lib/velocity');

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
  assert.deepStrictEqual(parseOrdersReport('', 0), { bySku: {}, byAsin: {}, lines: 0, units: 0 });
});

test('60 days is pulled as two 30-day reports (Amazon refuses longer ones)', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  const w = reportWindows(60, now);
  assert.strictEqual(w.length, 2);
  assert.strictEqual(w[0][0], '2026-08-07T00:00:00.000Z');
  assert.strictEqual(w[1][1], '2026-10-06T00:00:00.000Z');
  assert.strictEqual(w[0][1], w[1][0]);
  assert.strictEqual(reportWindows(30, now).length, 1);
  assert.strictEqual(reportWindows(45, now).length, 2);
});

test('pieces add up; a line in both pieces counts once; an empty (cancelled) piece is fine', () => {
  const a = [H, row('1', '2026-09-01T10:00:00Z', 'Shipped', 'S1', 'B000TEST01', '2'), row('2', '2026-09-02T10:00:00Z', 'Shipped', 'S1', 'B000TEST01', '1')].join('\n');
  const b = [H, row('2', '2026-09-02T10:00:00Z', 'Shipped', 'S1', 'B000TEST01', '1'), row('3', '2026-10-01T10:00:00Z', 'Shipped', 'S2', 'B000TEST02', '4')].join('\n');
  const s = parseOrdersReport([a, '', b], Date.parse('2026-08-07T00:00:00Z'));
  assert.deepStrictEqual(s.byAsin, { B000TEST01: 3, B000TEST02: 4 });
  assert.strictEqual(s.units, 7);
  assert.strictEqual(s.lines, 3);
});

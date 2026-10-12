const test = require('node:test');
const assert = require('node:assert');
const S = require('../lib/stuck');

test('stranded: units at Amazon with no listing, with the reason', () => {
  const body = 'primary-action\tdate-stranded\tstatus-primary\tstranded-reason\tasin\tsku\tfnsku\tproduct-name\tfulfillable-qty\tunfulfillable-qty\n'
    + 'Relist\t2026-09-01\tInactive\tListing closed\tB001\tSKU-A\tX001\tShampoo 33.8 oz\t12\t1\n'
    + 'Relist\t2026-09-01\tInactive\tListing closed\tB002\tSKU-B\tX002\tEmpty\t0\t0\n';
  const r = S.parseStranded(body);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].sku, r[0].units, r[0].reason], ['SKU-A', 13, 'Listing closed']);
});

test('unsellable: only SKUs with unsellable or researching units', () => {
  const body = 'sku\tfnsku\tasin\tproduct-name\tafn-fulfillable-quantity\tafn-unsellable-quantity\tafn-researching-quantity\n'
    + 'SKU-A\tX001\tB001\tShampoo\t100\t4\t0\nSKU-B\tX002\tB002\tCond\t50\t0\t0\nSKU-C\tX003\tB003\tMask\t5\t0\t2\n';
  assert.deepStrictEqual(S.parseUnsellable(body).map(x => [x.sku, x.unsellable, x.researching]), [['SKU-A', 4, 0], ['SKU-C', 0, 2]]);
});

test('aged: 181+ day units and every surcharge bucket added up', () => {
  const body = 'sku\tfnsku\tasin\tproduct-name\tavailable\tinv-age-0-to-90-days\tinv-age-181-to-270-days\tinv-age-365-plus-days\testimated-ais-181-210-days\testimated-ais-365-plus-days\testimated-storage-cost-next-month\trecommended-action\n'
    + 'SKU-A\tX001\tB001\tShampoo\t300\t200\t60\t10\t$12.50\t3.25\t4.10\tCreate removal order\n'
    + 'SKU-B\tX002\tB002\tCond\t40\t40\t0\t0\t0\t0\t0.50\tNo action required\n';
  const r = S.parseAged(body);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].aged181, r[0].surcharge, r[0].storageNext], [70, 15.75, 4.1]);
});

test('tied up: units × cost, unknown costs counted apart; a BOM and missing columns are fine', () => {
  assert.deepStrictEqual(S.tiedUp([{ sku: 'A', units: 10 }, { sku: 'B', units: 3 }], 'units', { A: 9.5 }), { total: 95, unknownUnits: 3 });
  assert.deepStrictEqual(S.parseUnsellable('﻿sku\tasin\nSKU-A\tB001\n'), []);
});

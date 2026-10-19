const test = require('node:test');
const assert = require('node:assert');
const { findConflicts, resolvePins } = require('../lib/fnsku-pick');

// The real case: Extra-Body Sculpting Gel, old SKU kept by the app, new listing made Oct 16.
const gel = { asin: 'B0FPJH8RZL', sku: 'BS-47MN-GI3G', fnsku: 'X00565HNWX' };
const fbaGel = {
  'BS-47MN-GI3G': { sku: 'BS-47MN-GI3G', asin: 'B0FPJH8RZL', fnSku: 'X00565HNWX', total: 0, lastUpdated: '2026-09-01T00:00:00Z' },
  'Extra Body Sculpt Gel - 5.1oz': { sku: 'Extra Body Sculpt Gel - 5.1oz', asin: 'B0FPJH8RZL', fnSku: 'X005DIWTZ9', total: 60, inbound: 60, lastUpdated: '2026-10-16T10:13:00Z' },
};

test('an ASIN with two listings and different FNSKUs is flagged, newest listing first', () => {
  const r = findConflicts([gel], fbaGel, {});
  assert.strictEqual(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.deepStrictEqual(c.current, { sku: 'BS-47MN-GI3G', fnsku: 'X00565HNWX' });
  assert.deepStrictEqual(c.options.map(o => o.fnsku), ['X005DIWTZ9', 'X00565HNWX']);
  assert.strictEqual(c.options[1].current, true);
  assert.deepStrictEqual(r.autoSwitch, []);
});

test('once the owner picked among exactly these listings it stays quiet; a new listing asks again', () => {
  assert.strictEqual(findConflicts([gel], fbaGel, { B0FPJH8RZL: ['BS-47MN-GI3G', 'Extra Body Sculpt Gel - 5.1oz'] }).conflicts.length, 0);
  const third = Object.assign({}, fbaGel, { 'GEL-3': { sku: 'GEL-3', asin: 'B0FPJH8RZL', fnSku: 'X009', total: 0 } });
  assert.strictEqual(findConflicts([gel], third, { B0FPJH8RZL: ['BS-47MN-GI3G', 'Extra Body Sculpt Gel - 5.1oz'] }).conflicts.length, 1);
});

test('the saved listing gone from Amazon with one other left: switch without asking', () => {
  const pom = { asin: 'B09XW2PPM5', sku: 'OLD-POM', fnsku: 'X003GXM269' };
  const fba = { 'MITCH Original Pomade Med/Low - 3oz': { sku: 'MITCH Original Pomade Med/Low - 3oz', asin: 'B09XW2PPM5', fnSku: 'X005DIWY59', total: 0 } };
  const r = findConflicts([pom], fba, {});
  assert.deepStrictEqual(r.autoSwitch, [{ asin: 'B09XW2PPM5', sku: 'MITCH Original Pomade Med/Low - 3oz', fnsku: 'X005DIWY59', from: { sku: 'OLD-POM', fnsku: 'X003GXM269' } }]);
  assert.strictEqual(r.conflicts.length, 0);
});

test('nothing to do: one listing, same FNSKU twice, or a SKU that belongs to another product', () => {
  assert.deepStrictEqual(findConflicts([gel], { a: fbaGel['BS-47MN-GI3G'] }, {}), { conflicts: [], autoSwitch: [] });
  const dup = { a: fbaGel['BS-47MN-GI3G'], b: Object.assign({}, fbaGel['BS-47MN-GI3G'], { sku: 'B2' }) };
  assert.strictEqual(findConflicts([gel], dup, {}).conflicts.length, 0);
  const other = { asin: 'B0OTHER', sku: 'Extra Body Sculpt Gel - 5.1oz', fnsku: 'X005DIWTZ9' };
  assert.strictEqual(findConflicts([gel, other], fbaGel, {}).conflicts.length, 0);
});

test('a hand fix holds over the sync until Amazon shows that FNSKU, then moves the product onto that listing', () => {
  assert.deepStrictEqual(resolvePins({ B0FPJH8RZL: 'x005diwtz9' }, fbaGel), [{ asin: 'B0FPJH8RZL', fnsku: 'X005DIWTZ9', sku: 'Extra Body Sculpt Gel - 5.1oz', release: true, skus: ['BS-47MN-GI3G', 'Extra Body Sculpt Gel - 5.1oz'] }]);
  // the new listing not in Amazon's stock list yet: keep the hand fix
  assert.deepStrictEqual(resolvePins({ B0FPJH8RZL: 'X005DIWTZ9' }, { a: fbaGel['BS-47MN-GI3G'] }), [{ asin: 'B0FPJH8RZL', fnsku: 'X005DIWTZ9', sku: null, release: false, skus: ['BS-47MN-GI3G'] }]);
});

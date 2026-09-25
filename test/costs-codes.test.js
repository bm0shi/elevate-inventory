const test = require('node:test');
const assert = require('node:assert/strict');
const { blendCosts } = require('../lib/costs');
const { normCode, normLoc, badQty, MAX_QTY, LOCATION_SLOTS } = require('../lib/codes');

test('blendCosts: regular cost is the highest (non-sale) price; a >3% cheaper lot is a sale', () => {
  const r = blendCosts([
    { unit_cost: 17.31, qty: 100, invoice_date: '2026-06-01' },
    { unit_cost: 17.31, qty: 50, invoice_date: '2026-07-01' },
    { unit_cost: 12.00, qty: 60, invoice_date: '2026-08-01' },   // Cosmoprof sale
  ]);
  assert.equal(r.regular, 17.31);
  assert.equal(r.units, 210);
  assert.ok(Math.abs(r.avg - (17.31 * 150 + 12 * 60) / 210) < 1e-9);
  assert.equal(r.saleUnits, 60);
  assert.equal(r.lowestSale, 12);
  assert.ok(Math.abs(r.saved - (17.31 - 12) * 60) < 1e-9);
  assert.equal(r.lots[0].invoice_date, '2026-08-01');   // newest first
});

test('blendCosts: a lot within 3% of regular is not a sale', () => {
  const r = blendCosts([{ unit_cost: 10, qty: 10 }, { unit_cost: 9.8, qty: 1 }]);
  assert.equal(r.saleUnits, 0);
});

test('blendCosts: no lots gives null', () => assert.equal(blendCosts([]), null));

test('blendCosts: bought mostly on sale — regular is still the shelf price (Tea Tree Leave-In)', () => {
  const r = blendCosts([
    { unit_cost: 25.20, qty: 24, invoice_date: '3/2/26' },
    { unit_cost: 19.50, qty: 240, invoice_date: '5/14/26' },   // stocked up on sale
    { unit_cost: 25.20, qty: 12, invoice_date: '8/20/26' },
  ]);
  assert.equal(r.regular, 25.2);
  assert.equal(r.saleUnits, 240);
  assert.ok(r.avg < 21);
});

test('blendCosts: prices older than 12 months before the newest invoice drop out', () => {
  const r = blendCosts([
    { unit_cost: 30, qty: 5, invoice_date: '1/5/24' },        // old, higher — ignored
    { unit_cost: 24, qty: 10, invoice_date: '2/1/26' },
    { unit_cost: 22, qty: 10, invoice_date: '9/1/26' },
  ]);
  assert.equal(r.regular, 24);
});

test('blendCosts: a price rise takes over once it is invoiced', () => {
  const r = blendCosts([{ unit_cost: 22.92, qty: 50, invoice_date: '2026-01-10' }, { unit_cost: 23.50, qty: 6, invoice_date: '2026-09-01' }]);
  assert.equal(r.regular, 23.5);
});

test('normCode: numeric barcodes match with or without leading zeros; text is upper-cased', () => {
  assert.equal(normCode('009531136929'), normCode('9531136929'));
  assert.equal(normCode(' x003qf6ajh '), 'X003QF6AJH');
  assert.equal(normCode(null), '');
});

test('normLoc: accepts a1, A-1, "a - 1"; rejects slots outside the rack map', () => {
  assert.equal(normLoc('a1'), 'A-1');
  assert.equal(normLoc(' b - 12 '), 'B-12');
  assert.equal(normLoc('A-07'), 'A-7');
  assert.equal(normLoc('C-1'), null);
  assert.equal(normLoc('A-21'), null);
  assert.equal(normLoc(''), null);
  assert.equal(LOCATION_SLOTS.length, 40);
});

test('badQty: 1..MAX_QTY only — a barcode typed into a qty box is rejected', () => {
  assert.equal(badQty(1), false);
  assert.equal(badQty(MAX_QTY), false);
  assert.equal(badQty(0), true);
  assert.equal(badQty(MAX_QTY + 1), true);
  assert.equal(badQty(12345678905), true);
  assert.equal(badQty(NaN), true);
  assert.equal(badQty(2.5), true);
});

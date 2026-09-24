const test = require('node:test');
const assert = require('node:assert/strict');
const { blendCosts } = require('../lib/costs');
const { normCode, normLoc, badQty, MAX_QTY, LOCATION_SLOTS } = require('../lib/codes');

test('blendCosts: regular cost is the price paid for the most units; a >3% cheaper lot is a sale', () => {
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

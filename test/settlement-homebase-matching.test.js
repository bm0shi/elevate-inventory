const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSettlementFlatFile, isPassThroughTax, INBOUND_FEE_PATTERNS } = require('../lib/settlement-parse');
const { parseHomebaseCsv } = require('../lib/homebase');
const { suggestProducts, crossCheck } = require('../lib/matching');

// The parser logs the layout it detects; keep test output quiet.
const quiet = (fn) => { const l = console.log, e = console.error; console.log = console.error = () => {}; try { return fn(); } finally { console.log = l; console.error = e; } };

const TALL = [
  ['settlement-id','settlement-start-date','settlement-end-date','deposit-date','total-amount','currency','transaction-type','order-id','sku','quantity-purchased','amount-type','amount-description','amount','posted-date','shipment-id'].join('\t'),
  ['1234567890','2026-08-15T00:00:00+00:00','2026-08-29T00:00:00+00:00','2026-08-31T00:00:00+00:00','1500.25','USD','','','','','','','','',''].join('\t'),
  ['1234567890','','','','','','Order','111-1','E7-D3O7-1IBL','2','ItemPrice','Principal','53.98','2026-08-20T10:00:00+00:00',''].join('\t'),
  ['1234567890','','','','','','Order','111-1','E7-D3O7-1IBL','','ItemFees','FBAPerUnitFulfillmentFee','-16.30','2026-08-20T10:00:00+00:00',''].join('\t'),
  ['1234567890','','','','','','other-transaction','','','','other-transaction','FBA Inbound Placement Service Fee','-40.00','08/29/2026','FBA19PXHJ001'].join('\t'),
].join('\n');

test('settlement (tall layout): header and every line, with dates normalised', () => {
  const { header, rows } = quiet(() => parseSettlementFlatFile(TALL));
  assert.equal(header.settlement_id, '1234567890');
  const principal = rows.find(r => r.amount_description === 'Principal');
  assert.equal(principal.amount, 53.98);
  assert.equal(principal.quantity, 2);
  assert.equal(principal.posted_date, '2026-08-20');
  const fee = rows.find(r => /Placement/.test(r.amount_description));
  assert.equal(fee.amount, -40);
  assert.equal(fee.shipment_id, 'FBA19PXHJ001');
});

test('settlement: a US date (08/29/2026) is read month-first, not as month 29', () => {
  const { rows } = quiet(() => parseSettlementFlatFile(TALL));
  const fee = rows.find(r => /Placement/.test(r.amount_description));
  assert.equal(fee.posted_date, '2026-08-29');
});

test('isPassThroughTax: marketplace-facilitator tax passes through; principal does not', () => {
  assert.equal(isPassThroughTax('ItemPrice', 'Tax'), true);
  assert.equal(isPassThroughTax('ItemPrice', 'Principal'), false);
  assert.equal(isPassThroughTax('ItemFees', 'MarketplaceFacilitatorTax-Principal'), true);
  assert.equal(isPassThroughTax('ItemFees', 'FBAPerUnitFulfillmentFee'), false);
});

test('INBOUND_FEE_PATTERNS picks out freight and placement, not selling fees', () => {
  assert.ok(INBOUND_FEE_PATTERNS.test('FBA Inbound Placement Service Fee'));
  assert.ok(INBOUND_FEE_PATTERNS.test('Inbound Transportation Charge'));
  assert.ok(!INBOUND_FEE_PATTERNS.test('Commission'));
  assert.ok(!INBOUND_FEE_PATTERNS.test('FBAPerUnitFulfillmentFee'));
});

test('Homebase CSV: one shift per punch, overnight shifts roll to the next day', () => {
  const csv = [
    'Name,Clock in date,Clock in time,Clock out date,Clock out time,Break length',
    'Maria Lopez,,,,,',
    'Maria Lopez,09/15/2026,8:00 AM,09/15/2026,4:30 PM,0.5',
    'Maria Lopez,09/16/2026,10:00 PM,09/16/2026,2:00 AM,0',
    'Totals,,,,,',
  ].join('\n');
  const r = parseHomebaseCsv(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].work_date, '2026-09-15');
  assert.equal(r.rows[0].break_minutes, 30);
  const night = r.rows[1];
  assert.equal((night.clock_out - night.clock_in) / 3600000, 4);
});

test('matching: only one clear winner is suggested, never a close call', () => {
  // A short or vague description gets no suggestion at all (the bar is high on purpose).
  assert.deepEqual(suggestProducts('AWAPUHI 33.8', [{ asin: 'A1', name: 'Paul Mitchell Awapuhi Shampoo, 33.8 fl. oz.' }]), []);
  const catalog = [
    { asin: 'A1', name: 'Paul Mitchell Awapuhi Shampoo, 33.8 fl. oz.' },
    { asin: 'A2', name: 'Tea Tree Special Conditioner, 33.8 fl. oz.' },
  ];
  const s = suggestProducts('PAUL MITCHELL AWAPUHI SHAMPOO 33.8 FL OZ', catalog);
  assert.equal(s.length, 1);
  assert.equal(s[0].asin, 'A1');
  assert.equal(s[0].score, undefined);   // no percentage shown to workers
});

test('matching: a shampoo line bound to a conditioner is flagged', () => {
  const warnings = crossCheck('TEA TREE SPECIAL SHAMPOO 33.8OZ', 'Tea Tree Special Conditioner, 33.8 fl. oz.');
  assert.ok(Array.isArray(warnings) ? warnings.length > 0 : warnings && warnings.ok === false);
});

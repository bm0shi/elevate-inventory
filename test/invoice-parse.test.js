// Cosmoprof invoice parsing. These inputs mirror real invoice layouts; the
// comments in lib/invoice-parse.js describe the incidents each rule prevents.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findInvoiceDate, parseInvoiceText, parseCosmoInvoice } = require('../lib/invoice-parse');

test('findInvoiceDate normalises every date shape to M/D/YY', () => {
  assert.equal(findInvoiceDate('Invoice 9/18/26 Beauty Systems'), '9/18/26');
  assert.equal(findInvoiceDate('09/18/2026'), '9/18/26');
  assert.equal(findInvoiceDate('Order placed Sep 18, 2026'), '9/18/26');
  assert.equal(findInvoiceDate('Sept. 3 2026'), '9/3/26');
  assert.equal(findInvoiceDate('18 September 2026'), '9/18/26');
  assert.equal(findInvoiceDate('2026-09-18'), '9/18/26');
  assert.equal(findInvoiceDate('no date here'), '');
});

test('a multi-page invoice becomes ONE order with every page\'s lines', () => {
  // Cosmoprof repeats "FOR ORDER NUMBER" on every page. Writing per page used
  // to keep only the last page.
  const text = [
    '8/25/26  Beauty Systems Group',
    'FOR ORDER NUMBER: 261642335',
    'ITEM  DESCRIPTION  ORDERED  PRICE  SHIPPED  EXTENDED',
    '570131 AWAPUHI SHAMPOO 33.8OZ 6 12.50 6 75.00 N',
    '8/25/26  Beauty Systems Group',
    'FOR ORDER NUMBER: 261642335',
    '573267 TEA TREE COND 33.8OZ 4 10.00 4 40.00 N',
  ].join('\n');
  const orders = parseInvoiceText(text);
  assert.equal(orders.size, 1);
  const o = orders.get('261642335');
  assert.equal(o.pages, 2);
  assert.equal(o.date, '8/25/26');
  assert.deepEqual(o.items.map(i => [i.cosmo_num, i.qty_shipped, i.unit_cost]), [['570131', 6, 12.5], ['573267', 4, 10]]);
});

test('two different orders in one file stay separate, each with its own date', () => {
  const text = [
    '8/25/26  Beauty Systems Group', 'FOR ORDER NUMBER: 111111111',
    '570131 AWAPUHI SHAMPOO 6 12.50 6 75.00 N',
    '9/02/26  Beauty Systems Group', 'FOR ORDER NUMBER: 222222222',
    '573267 TEA TREE COND 4 10.00 4 40.00 N',
  ].join('\n');
  const orders = parseInvoiceText(text);
  assert.equal(orders.size, 2);
  assert.equal(orders.get('111111111').date, '8/25/26');
  assert.equal(orders.get('222222222').date, '9/02/26');
});

test('a printed line with no shipped column is recorded as not shipped', () => {
  const text = ['FOR ORDER NUMBER: 333333333', 'ITEM DESCRIPTION ORDERED PRICE SHIPPED EXTENDED', '570131 AWAPUHI SHAMPOO 6 12.50'].join('\n');
  const it = parseInvoiceText(text).get('333333333').items[0];
  assert.equal(it.qty_shipped, 0);
  assert.equal(it.not_shipped, true);
});

test('a line that looks like an item but does not parse is reported, never dropped', () => {
  const text = ['FOR ORDER NUMBER: 444444444', '570131 SOMETHING GARBLED'].join('\n');
  assert.equal(parseInvoiceText(text).get('444444444').rejected.length, 1);
});

test('the store order (FS D…) on the invoice is picked up', () => {
  const text = ['FOR ORDER NUMBER: 555555555', 'SHP# 139766144 FS D07163227', '570131 AWAPUHI 6 12.50 6 75.00 N'].join('\n');
  assert.equal(parseInvoiceText(text).get('555555555').oms, 'D07163227');
});

test('parseCosmoInvoice reads the old one-line format', () => {
  const r = parseCosmoInvoice('ORDER NUMBER: 900001\nDate: 9/18/26\n570131 AWAPUHI SHAMPOO 33OZ 6 12.50 6 75.00 N');
  assert.equal(r.orderNumber, '900001');
  assert.equal(r.date, '9/18/26');
  assert.deepEqual(r.items.map(i => [i.cosmo_num, i.qty_shipped]), [['570131', 6]]);
});

test('parseCosmoInvoice reads the new format (description on the line above) and 7-digit item numbers', () => {
  const r = parseCosmoInvoice('OMS Order ID: D 0 7 1 5 6 9 1 2\nPaul Mitchell Awapuhi Shampoo 33.8oz\n1570131 12 $12.50');
  assert.equal(r.orderNumber, 'D07156912');
  assert.equal(r.items[0].cosmo_num, '570131');
  assert.equal(r.items[0].qty_shipped, 12);
  assert.match(r.items[0].description, /Awapuhi/);
});

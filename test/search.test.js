const test = require('node:test');
const assert = require('node:assert');
const { terms, rankProduct } = require('../lib/search');

test('terms: words become ILIKE patterns, wildcards typed by the user are literal', () => {
  const t = terms('  tea   tree 50% ');
  assert.strictEqual(t.raw, 'tea tree 50%');
  assert.deepStrictEqual(t.words, ['%tea%', '%tree%', '%50\\%%']);
  assert.strictEqual(terms('x_1').any, '%x\\_1%');
  assert.deepStrictEqual(terms('').words, []);
});

test('rank: an exact ASIN / FNSKU / SKU / barcode beats any name match', () => {
  const byName = { asin: 'B000AAAA01', name: 'B000MD65FO refill' };
  const exact = { asin: 'B000MD65FO', name: 'Tea Tree Special Shampoo, 33.8 fl oz' };
  assert.ok(rankProduct(exact, 'b000md65fo') > rankProduct(byName, 'b000md65fo'));
  assert.strictEqual(rankProduct({ asin: 'B1', fnsku: 'X003EH4VQ1', name: 'n' }, 'x003eh4vq1'), 1000);
  assert.strictEqual(rankProduct({ asin: 'B1', name: 'n', upc_norm: '9531113' }, '009531113', '9531113'), 950);
});

test('rank: starts-with beats contains; all words in any order still match; no match is 0', () => {
  const a = { asin: 'B1', name: 'Tea Tree Special Shampoo, 33.8 fl oz' };
  const b = { asin: 'B2', name: 'Awapuhi Wild Ginger by Paul Mitchell, Tea Tree blend' };
  assert.ok(rankProduct(a, 'tea tree') > rankProduct(b, 'tea tree'));
  assert.ok(rankProduct(a, 'shampoo tea') > 0);
  assert.strictEqual(rankProduct(a, 'conditioner'), 0);
});

test('rank: among name matches, the one on the shelf comes first', () => {
  const none = { asin: 'B1', name: 'Tea Tree Special Shampoo, 128 Fl Oz', onhand: 0 };
  const some = { asin: 'B2', name: 'Tea Tree Special Shampoo, 33.8 fl oz', onhand: 620 };
  assert.ok(rankProduct(some, 'tea tree') > rankProduct(none, 'tea tree'));
});

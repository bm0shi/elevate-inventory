const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/brand-finder');

test('brands from a pasted Cosmoprof list: counts, bullets and repeats dropped (owner 11/8)', () => {
  const t = 'Brands\nPaul Mitchell (312)\n• Redken\nredken\n- Joico, Pureology; Matrix\nShop All\n  Olaplex  (1,204)\nA';
  assert.deepStrictEqual(B.parseBrands(t), ['Paul Mitchell', 'Redken', 'Joico', 'Pureology', 'Matrix', 'Olaplex']);
});

test('third-party sellers leave Amazon out; a brand qualifies on its open listings\' units a day', () => {
  const p = (asin, offers, amazon, monthly, brand = 'Joico', price = 20) => ({ asin, brand, offerCount: offers, amazonSelling: amazon, monthlySold: monthly, buyBoxPrice: price, salesRank: 100 });
  assert.strictEqual(B.thirdPartySellers(p('A', 4, true, 0)), 3);
  assert.strictEqual(B.thirdPartySellers(p('A', null, false, 0)), null);
  const s = B.scoreBrand('Joico', [
    p('A1', 6, false, 2000),          // open, 66.7/day
    p('A2', 4, true, 1500),           // 3 3P sellers: open, 50/day
    p('A3', 3, true, 3000),           // only 2 3P: not open
    p('A4', 8, false, null),          // open, no sales figure
    p('A5', 9, false, 900, 'Other'),  // another brand: left out
  ], { minSellers: 3, minPerDay: 100 });
  assert.strictEqual(s.checked, 4); assert.strictEqual(s.open, 3);
  assert.strictEqual(s.openPerDay, 116.7); assert.strictEqual(s.allPerDay, 216.7);
  assert.strictEqual(s.noFigure, 1); assert.strictEqual(s.amazonOn, 2); assert.strictEqual(s.qualifies, true);
  assert.strictEqual(s.listings[0].asin, 'A3');
  assert.strictEqual(B.scoreBrand('Joico', [p('A2', 4, true, 1500)], { minPerDay: 100 }).qualifies, false);
});

test('finder selection for a brand', () => {
  assert.deepStrictEqual(B.finderSelection('Redken', { minSellers: 3, perBrand: 30 }),
    { brand: ['Redken'], current_COUNT_NEW_gte: 3, current_SALES_gte: 1, sort: [['current_SALES', 'asc']], perPage: 50, page: 0 });
});

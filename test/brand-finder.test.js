const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/brand-finder');

test('brands from a pasted Cosmoprof list: counts, bullets and repeats dropped (owner 11/8)', () => {
  const t = 'Brands\nPaul Mitchell (312)\n• Redken\nredken\n- Joico, Pureology; Matrix\nShop All\n  Olaplex  (1,204)\nA';
  assert.deepStrictEqual(B.parseBrands(t), ['Paul Mitchell', 'Redken', 'Joico', 'Pureology', 'Matrix', 'Olaplex']);
});

test('spellings to try: Cosmoprof company names → Amazon brand names (owner 11/8, John Paul Mitchell Systems found nothing)', () => {
  const v = n => B.brandVariants(n);
  assert.ok(v('John Paul Mitchell Systems').includes('Paul Mitchell'));
  assert.ok(v('Kenra Professional').includes('Kenra'));
  assert.ok(v('Wella Professionals').includes('Wella'));
  assert.ok(v('K18 Biomimetic Hairscience').includes('K18'));
  assert.ok(v('ACTIIV Hair Science').includes('ACTIIV'));
  assert.ok(v('The GelBottle Inc').includes('GelBottle'));
  assert.ok(v('Johnny B. Hair Care').includes('Johnny B.'));
  assert.ok(v('Mehaz Professional').includes('Mehaz'));
  assert.deepStrictEqual(v('Joico'), ['Joico']);
  assert.ok(B.brandVariants('Zotos Professional', ['Zotos Pro']).includes('Zotos Pro'));
  assert.ok(B.matchesBrand('Paul Mitchell', v('John Paul Mitchell Systems')));
  assert.ok(B.matchesBrand('JOHN PAUL MITCHELL SYSTEMS', ['Paul Mitchell']));
  assert.ok(!B.matchesBrand('Redken', v('John Paul Mitchell Systems')));
});

test('units a day: the badge, else rank drops (marked estimate), else 0', () => {
  assert.deepStrictEqual(B.unitsPerDay({ monthlySold: 300, rankDrops30: 90 }), { perDay: 10, est: false });
  assert.deepStrictEqual(B.unitsPerDay({ monthlySold: null, rankDrops30: 60 }), { perDay: 2, est: true });
  assert.deepStrictEqual(B.unitsPerDay({}), { perDay: 0, est: false });
});

test('the brand selling itself, from the real offers and seller names (owner 11/8)', () => {
  const offers = { A1: { sellers: [{ id: 'PMS', bb: true }, { id: 'S1' }, { id: 'ATVPDKIKX0DER' }] }, A2: { sellers: [{ id: 'PMS' }, { id: 'S2' }] }, A3: { error: 'x' } };
  const names = { PMS: 'John Paul Mitchell Systems', S1: 'Beauty Deals LLC', S2: 'Salon Direct' };
  const r = B.brandSellers(offers, names, B.brandVariants('John Paul Mitchell Systems'), 'ATVPDKIKX0DER');
  assert.strictEqual(r.sells, true); assert.strictEqual(r.checked, 2);
  assert.deepStrictEqual(r.sellers, [{ id: 'PMS', name: 'John Paul Mitchell Systems', listings: 2, buyBox: 1 }]);
  assert.strictEqual(B.brandSellers(offers, { S1: 'x' }, ['Joico'], 'ATVPDKIKX0DER').sells, false);
});

test('scoring: open = 3+ sellers other than Amazon and the brand; real offers when read; brands matched by any spelling', () => {
  const p = (asin, offers, amazon, monthly, brand = 'Paul Mitchell', drops) => ({ asin, brand, offerCount: offers, amazonSelling: amazon, monthlySold: monthly, rankDrops30: drops, buyBoxPrice: 20, salesRank: 100 });
  const ctx = { variants: B.brandVariants('John Paul Mitchell Systems'), brandSellerIds: ['PMS'],
    offers: { A1: { sellers: [{ id: 'PMS' }, { id: 'S1' }, { id: 'S2' }, { id: 'S3' }] }, A2: { sellers: [{ id: 'PMS' }, { id: 'S1' }, { id: 'S2' }] } } };
  const s = B.scoreBrand('John Paul Mitchell Systems', [
    p('A1', 4, false, 1500),             // real: 3 resellers besides the brand → open, 50/day
    p('A2', 9, false, 3000),             // real: only 2 besides the brand → not open
    p('A3', 6, true, null, 'Tea Tree', 90), // Keepa: 5 3P → open, ~3/day estimated
    p('A4', 6, false, 900, 'Redken'),    // another brand: left out
  ], { minSellers: 3, minPerDay: 50 }, ctx);
  assert.strictEqual(s.checked, 3); assert.strictEqual(s.open, 2);
  assert.strictEqual(s.openPerDay, 53); assert.strictEqual(s.estimated, 1); assert.strictEqual(s.qualifies, true);
  assert.deepStrictEqual(s.amazonBrands.sort(), ['Paul Mitchell', 'Tea Tree']);
  assert.strictEqual(s.listings.find(l => l.asin === 'A1').brandSells, true);
  assert.strictEqual(s.listings.find(l => l.asin === 'A3').brandSells, null);
});

test('finder selection: every spelling at once', () => {
  assert.deepStrictEqual(B.finderSelection('Redken', { minSellers: 3, perBrand: 30 }, ['Redken', 'Redken 5th Avenue']),
    { brand: ['Redken', 'Redken 5th Avenue'], current_COUNT_NEW_gte: 3, current_SALES_gte: 1, sort: [['current_SALES', 'asc']], perPage: 50, page: 0 });
});

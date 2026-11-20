const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/price-list');

// A made-up list laid out like the Ardell volume price list (owner 11/20):
// title rows, a header with Dealer / Salon / Volume columns and a Retail one,
// section rows, dashed UPCs, a "$" cost and a UPC listed twice.
test('reads an .xlsx price list: UPCs, names, case packs and every cost column (not retail)', () => {
  const r = L.readPriceList(fs.readFileSync(path.join(__dirname, 'fixtures', 'price-list-sample.xlsx')), 'sample.xlsx');
  assert.deepEqual(r.costCols, ['Dealer Cost', 'Salon Cost', 'Volume Price']);
  assert.equal(r.rows.length, 3, 'the duplicate UPC and the row with no code are left out');
  assert.deepEqual(r.rows[0], { upc: '074764383693', name: 'Sample Lashes 750', item: '38369', section: 'SAMPLE LASHES', casePack: 72, inner: 4, costs: { 'Dealer Cost': 3.59, 'Salon Cost': 5.99, 'Volume Price': 2.8 } });
  assert.equal(r.rows[1].name, 'Sample Lashes 751');
  assert.equal(r.rows[2].upc, '074764680235');                 // 13-digit EAN with a leading 0 = the UPC
  assert.equal(r.rows[2].costs['Dealer Cost'], 3.3);           // "$3.30"
  assert.equal(r.rows[2].section, 'SAMPLE GLUE & TOOLS');
  assert.equal(r.rows[2].name, 'Sample Remover & Co');
});

test('reads the same list pasted from Excel (tabs) or as CSV', () => {
  const tsv = 'Item #\tDescription\tUPC Code\tCase Pack\tDealer Cost\tMSRP\n38369\tSample Lashes 750\t0-7476438369-3\t72\t3.59\t9.99\n';
  const a = L.parseTable(L.readDelimited(tsv));
  assert.deepEqual(a.costCols, ['Dealer Cost']);
  assert.equal(a.rows[0].upc, '074764383693');
  const csv = 'Description,UPC,Wholesale\n"Lashes, Natural 110",074764615671,"$1,234.50"\n';
  const b = L.parseTable(L.readDelimited(csv));
  assert.equal(b.rows[0].name, 'Lashes, Natural 110');
  assert.equal(b.rows[0].costs.Wholesale, 1234.5);
});

test('a list with no UPC or no cost column says so', () => {
  assert.throws(() => L.parseTable([['Name', 'Price'], ['x', 1]]), /No UPC column/);
  assert.throws(() => L.parseTable([['Name', 'UPC', 'Retail'], ['x', '074764383693', 9]]), /No cost column/);
});

test('profit after Amazon fees: referral % (15% when unknown, $0.30 minimum) + FBA fee + extra cost', () => {
  const k = { newFbaPrice: 10, referralPct: 15, pickPackFee: 3.5 };
  const p = L.profitFor(2.8, k, 0.5);
  assert.equal(p.price, 10);
  assert.equal(+p.referral.toFixed(2), 1.5);
  assert.equal(+p.profit.toFixed(2), 1.7);                     // 10 − 1.50 − 3.50 − 2.80 − 0.50
  assert.equal(+p.roi.toFixed(3), +(1.7 / 3.3).toFixed(3));
  assert.equal(L.profitFor(1, { buyBoxPrice: 1.5, pickPackFee: 1 }).referral, 0.30);
  assert.equal(L.profitFor(1, { newFbaPrice: 9 }).profit, undefined, 'no FBA fee: no profit figure, never a guess');
  assert.equal(L.profitFor(1, {}).price, null);
});

test('a row is scored against its best-selling listing, per cost column; packs are flagged', () => {
  const row = { upc: '074764383693', costs: { Dealer: 3.59, Volume: 2.8 } };
  const listings = [
    { asin: 'B0SLOW', k: { asin: 'B0SLOW', title: 'Lashes 750', newFbaPrice: 9, referralPct: 15, pickPackFee: 3, monthlySold: 50, offerCount: 4 } },
    { asin: 'B0FAST', k: { asin: 'B0FAST', title: 'Lashes 750, Pack of 4', newFbaPrice: 12, referralPct: 15, pickPackFee: 3.2, monthlySold: 300, offerCount: 5 } },
  ];
  const s = L.scoreRow(row, listings, 0);
  assert.equal(s.asin, 'B0FAST');
  assert.equal(s.others, 1);
  assert.equal(s.pack, 4);
  assert.equal(+s.byCost.Volume.profit.toFixed(2), +(12 - 1.8 - 3.2 - 2.8).toFixed(2));
  assert.equal(+s.ourMo.toFixed(1), 50);                       // 300 a month ÷ (5 sellers + us)
  assert.equal(L.scoreRow(row, [], 0).found, false);
  assert.equal(L.packOf('Ardell Naked Lashes 420, 4 Pairs'), 1);
  assert.equal(L.packOf('Clubman Powder 4 oz (2 Pack)'), 2);
});

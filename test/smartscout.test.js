const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, parseSmartScout, pieFor, mergeRows, sellerFromFilename, sellerKey } = require('../lib/smartscout');

// Header and one row exactly as SmartScout's "Products" export writes them.
const HEADER = '﻿Product Image,ASIN,Page Score,Title,Brand,Est. Monthly Revenue,Est. 12 Month Revenue,Est. Monthly Units Sold,Est. 12 Month Units Sold,Main Category Rank,Main Category Name,Primary Subcategory Rank,Primary Subcategory Name,1 Month Growth,12 Month Growth,Opportunity Score,Est. New Seller Share,Buy Box Price,Item Count,FBA Sellers,All Sellers,Amazon In-Stock Rate,12-24 Month Revenue,Child Review Count,Listing Review Count,Rating,Bought in Past Month,Parent ASIN,Is Variation,Return Rate,Last Refreshed,TTM Start Date,TTM End Date,TTM Revenue Change';
const TEA = '31vlbaJzOtL.jpg,B000MD65FO,10,"Tea Tree Special Shampoo, Deep Cleans, Refreshes Scalp, For All Hair Types, Especially Oily Hair, 33.8 fl. oz.",Tea Tree,459558.94,6246740.34,9454,135585,530,Beauty & Personal Care,9,Hair Shampoo,-0.21,0.023,4,9454,48.61,1,5,8,1,6105653.94,2726,61602,4.6,9000,B0CXXXJ49Q,TRUE,,09/24/2026,08/17/2025,08/16/2026,"$141,086.40"';

test('reads a SmartScout Products export by header name', () => {
  const r = parseSmartScout(HEADER + '\r\n' + TEA + '\r\n');
  assert.strictEqual(r.rows.length, 1);
  const t = r.rows[0];
  assert.strictEqual(t.asin, 'B000MD65FO');
  assert.strictEqual(t.title, 'Tea Tree Special Shampoo, Deep Cleans, Refreshes Scalp, For All Hair Types, Especially Oily Hair, 33.8 fl. oz.');
  assert.strictEqual(t.units, 9454);
  assert.strictEqual(t.price, 48.61);
  assert.strictEqual(t.fbaSellers, 5);
  assert.strictEqual(t.amazonInStock, 1);
  // "Est. 12 Month Units Sold" must not be read as the monthly figure.
  assert.strictEqual(r.mapped.units, 'Est. Monthly Units Sold');
});

test('a file with no ASIN column is refused', () => {
  assert.throws(() => parseSmartScout('Name,Units\nfoo,3\n'), /No ASIN column/);
});

test('quoted fields keep commas, quotes and newlines', () => {
  assert.deepStrictEqual(parseCsv('a,"b, ""c""\nd",e\n1,2,3'), [['a', 'b, "c"\nd', 'e'], ['1', '2', '3']]);
});

test('pie: Amazon in stock all month, 5 FBA sellers incl. Amazon → 4-way split of 5%', () => {
  const p = pieFor({ units: 9454, fbaSellers: 5, amazonInStock: 1 }, {});
  assert.strictEqual(p.amazonSrc, 'instock');
  assert.strictEqual(p.sellers3P, 4);
  assert.ok(Math.abs(p.pie - 472.7) < 0.01);
  assert.ok(Math.abs(p.fair - 118.175) < 0.01);
});

test('pie: Keepa 90-day Amazon Buy Box % wins over the in-stock estimate', () => {
  const p = pieFor({ units: 1000, fbaSellers: 4, amazonInStock: 1 }, { amazonBuyBoxPct: 70 });
  assert.strictEqual(p.amazonSrc, 'keepa');
  assert.ok(Math.abs(p.pie - 300) < 1e-9);
  assert.strictEqual(p.sellers3P, 3);
});

test('pie: Amazon not selling → every FBA seller is third-party', () => {
  const p = pieFor({ units: 300, fbaSellers: 3, amazonInStock: 0 }, {});
  assert.strictEqual(p.pie, 300);
  assert.strictEqual(p.sellers3P, 3);
});

test('newer upload wins per ASIN', () => {
  const m = mergeRows([{ id: 1, rows: [{ asin: 'A', units: 1 }, { asin: 'B', units: 5 }] }, { id: 2, rows: [{ asin: 'A', units: 9 }] }]);
  assert.strictEqual(m.A.units, 9);
  assert.strictEqual(m.B.units, 5);
});

// Header and rows as SmartScout's seller "Offers" export writes them.
const OFFERS = '"","Image","ASIN","Monthly Revenue","Buy Box Percentage","Brand","Category","Rank","Subcategory","FBA","Offer Price"\n'
  + '"","31vlbaJzOtL.jpg","B000MD65FO","14338.24","3.11","Tea Tree","Beauty & Personal Care","530","Hair Shampoo","true","50"\n'
  + '"","31P2+uwlsrL.jpg","B09B1PRHKR","485.74","0.5","Tea Tree","Beauty & Personal Care","95754","Hair Shampoo","false","25"\n';

test('seller Offers export: detected, revenue is the seller\'s, units = revenue ÷ price', () => {
  const r = parseSmartScout(OFFERS);
  assert.strictEqual(r.kind, 'seller');
  const t = r.rows[0];
  assert.strictEqual(t.buyBoxPct, 3.11);
  assert.strictEqual(t.sellerRevenue, 14338.24);
  assert.strictEqual(t.revenue, undefined);
  assert.strictEqual(t.price, 50);
  assert.strictEqual(t.fba, true);
  assert.ok(Math.abs(t.sellerUnits - 286.8) < 0.01);
  // 0.5 in a column of percentages stays 0.5%, not 50%.
  assert.strictEqual(r.rows[1].buyBoxPct, 0.5);
  assert.strictEqual(r.rows[1].fba, false);
});

test('brand Products export is detected as brand', () => {
  assert.strictEqual(parseSmartScout(HEADER + '\n' + TEA).kind, 'brand');
});

test('seller name from the export file name', () => {
  assert.strictEqual(sellerFromFilename('SmartScout - Beauty is...Urban Bliss Salon - Offers 2026-09-24 10_46.csv'), 'Beauty is...Urban Bliss Salon');
  assert.strictEqual(sellerFromFilename('SmartScout_-_Beauty_is...Urban_Bliss_Salon_-_Offers_2026-09-24_10_46'), 'Beauty is...Urban Bliss Salon');
  assert.strictEqual(sellerFromFilename('export.csv'), null);
  assert.strictEqual(sellerKey('Beauty is... Urban Bliss Salon'), sellerKey('Beauty is...Urban Bliss Salon'));
});

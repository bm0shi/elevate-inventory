// ============================================================
// SMARTSCOUT CSV EXPORTS — the owner uploads them in Admin → Smart Scout.
//   brand:  "SmartScout - Products" export for a brand (Paul Mitchell, Tea
//           Tree, MITCH): one row per listing with the listing's estimated
//           monthly units, Buy Box price, FBA seller count and how often
//           Amazon is in stock.
//   seller: SmartScout's "Offers" export for one seller (a competitor, or
//           us): per product, the seller's Buy Box %, their monthly revenue
//           and their offer price. It has no units column, so the seller's
//           units are revenue ÷ offer price. The seller's name is in the file
//           name ("SmartScout - <seller> - Offers <date>").
// Columns are found by header name, not position, so a reordered or trimmed
// export still reads. Pure: text in, rows out.
//
// THE PIE. A listing's monthly units are split between Amazon and the
// third-party sellers. What Amazon leaves is the pie the third-party FBA
// sellers (us included) fight over:
//   pie  = listing units × (1 − Amazon's Buy Box share)
//   fair = pie ÷ third-party FBA sellers
// Amazon's share is Keepa's 90-day Buy Box % when we have it; otherwise
// SmartScout's Amazon in-stock rate × AMAZON_WIN_WHEN_IN_STOCK (Amazon wins
// nearly every Buy Box it's in stock for on these listings).
// ============================================================

const AMAZON_WIN_WHEN_IN_STOCK = 95;

// Full CSV parse: quoted fields may hold commas, quotes ("") and newlines.
function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(x => x.trim() !== '')) rows.push(row.map(x => x.trim()));
  return rows;
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9%]/g, '');

// field → header names (normalized) it may appear under, best first.
const FIELDS = {
  asin:           ['asin'],
  title:          ['title', 'producttitle', 'productname', 'name'],
  brand:          ['brand'],
  units:          ['estmonthlyunitssold', 'monthlyunitssold', 'estmonthlyunits', 'monthlyunits', 'unitssold', 'units'],
  revenue:        ['estmonthlyrevenue', 'monthlyrevenue', 'revenue'],
  price:          ['buyboxprice', 'offerprice', 'price'],
  fba:            ['fba'],
  fbaSellers:     ['fbasellers'],
  allSellers:     ['allsellers', 'numberofsellers', 'sellers'],
  amazonInStock:  ['amazoninstockrate', 'amazoninstock'],
  bought:         ['boughtinpastmonth'],
  newSellerShare: ['estnewsellershare'],
  parentAsin:     ['parentasin'],
  growth1m:       ['1monthgrowth'],
  subcategory:    ['primarysubcategoryname'],
  subRank:        ['primarysubcategoryrank'],
  refreshed:      ['lastrefreshed'],
  // Seller-level columns, if a seller export has them.
  sellerUnits:    ['estsellermonthlyunits', 'estsellerunits', 'sellermonthlyunits', 'sellerunits'],
  sellerRevenue:  ['estsellermonthlyrevenue', 'estsellerrevenue', 'sellermonthlyrevenue', 'sellerrevenue'],
  buyBoxPct:      ['buyboxshare', 'buyboxpercentage', 'buybox%', 'buyboxpct', 'buyboxownership', 'buyboxownership%'],
};
const TEXT_FIELDS = new Set(['asin', 'title', 'brand', 'parentAsin', 'subcategory', 'refreshed', 'fba']);

function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '' || s === '-' || /^n\/?a$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Returns { kind, columns, mapped: {field: header}, rows: [...], skipped }.
// kind: 'brand' when the file has listing units (Products export), 'seller'
// when it has a seller's Buy Box % / revenue but no units (Offers export).
// Throws when there's no ASIN column — the upload is then refused with the
// headers it did find, so a wrong file is obvious.
function parseSmartScout(text) {
  const all = parseCsv(text);
  const hi = all.findIndex(r => r.some(c => norm(c) === 'asin'));
  if (hi < 0) throw new Error('No ASIN column found. First line: ' + (all[0] || []).slice(0, 8).join(', '));
  const header = all[hi], nh = header.map(norm);
  const col = {}, mapped = {};
  for (const [f, names] of Object.entries(FIELDS)) {
    for (const n of names) {
      const i = nh.indexOf(n);
      if (i >= 0 && !Object.values(col).includes(i)) { col[f] = i; mapped[f] = header[i]; break; }
    }
  }
  const kind = col.units != null ? 'brand' : (col.buyBoxPct != null || col.sellerRevenue != null || col.revenue != null) ? 'seller' : 'brand';
  const rows = []; let skipped = 0;
  for (const r of all.slice(hi + 1)) {
    const asin = String(r[col.asin] || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin)) { skipped++; continue; }
    const o = { asin };
    for (const f of Object.keys(col)) {
      if (f === 'asin') continue;
      o[f] = TEXT_FIELDS.has(f) ? (r[col[f]] || '') : num(r[col[f]]);
    }
    // Amazon in-stock rate comes as 0..1; accept 0..100 too.
    if (o.amazonInStock != null && o.amazonInStock > 1) o.amazonInStock = o.amazonInStock / 100;
    if (o.fba != null) o.fba = /^(true|yes|1|y)$/i.test(o.fba);
    if (kind === 'seller') {
      // An Offers export's revenue is the seller's own, not the listing's.
      if (o.sellerRevenue == null && o.revenue != null) o.sellerRevenue = o.revenue;
      delete o.revenue;
      if (o.sellerUnits == null && o.sellerRevenue != null && o.price > 0) o.sellerUnits = Math.round(o.sellerRevenue / o.price * 10) / 10;
    }
    rows.push(o);
  }
  // Buy Box % may come as 0..1 or 0..100 — decide for the whole column (a
  // single 0.5 could be either), store 0..100.
  if (col.buyBoxPct != null && rows.length && rows.every(o => o.buyBoxPct == null || o.buyBoxPct <= 1)) {
    rows.forEach(o => { if (o.buyBoxPct != null) o.buyBoxPct = o.buyBoxPct * 100; });
  }
  return { kind, columns: header, mapped, rows, skipped };
}

// "SmartScout - Beauty is...Urban Bliss Salon - Offers 2026-09-24 10_46.csv"
// → "Beauty is...Urban Bliss Salon". Downloads sometimes swap spaces for _.
function sellerFromFilename(fn) {
  const s = String(fn || '').replace(/\.csv$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const m = s.match(/^SmartScout\s*-\s*(.+?)\s*-\s*(Offers|Products)\b/i);
  return m ? m[1].trim() : null;
}

// Seller names compared loosely ("Beauty is... Urban Bliss Salon" = "Beauty is...Urban Bliss Salon").
const sellerKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The pie for one listing. ss: SmartScout row; k: cached Keepa entry (may be
// empty). Returns null when SmartScout has no unit estimate.
function pieFor(ss, k) {
  if (!ss || ss.units == null) return null;
  k = k || {};
  let amazonPct, amazonSrc;
  if (k.amazonBuyBoxPct != null) { amazonPct = Number(k.amazonBuyBoxPct); amazonSrc = 'keepa'; }
  else if (ss.amazonInStock != null) { amazonPct = ss.amazonInStock * AMAZON_WIN_WHEN_IN_STOCK; amazonSrc = 'instock'; }
  else { amazonPct = 0; amazonSrc = 'none'; }
  amazonPct = Math.min(100, Math.max(0, amazonPct));
  // FBA Sellers counts Amazon too when Amazon sells the listing.
  const amazonOn = amazonPct > 0 || (ss.amazonInStock || 0) > 0;
  const sellers3P = Math.max(1, (ss.fbaSellers != null ? ss.fbaSellers : 1) - (amazonOn && ss.fbaSellers ? 1 : 0));
  const pie = ss.units * (1 - amazonPct / 100);
  return { units: ss.units, amazonPct, amazonSrc, amazonUnits: ss.units - pie, pie, sellers3P, fair: pie / sellers3P };
}

// Merge uploads into one row per ASIN; later uploads win. uploads: oldest
// first, each { rows }.
function mergeRows(uploads) {
  const by = {};
  for (const u of uploads) for (const r of (u.rows || [])) by[r.asin] = Object.assign({}, r, { uploadId: u.id, uploadedAt: u.uploaded_at });
  return by;
}

// Short column labels for the Smart Scout Orders table. The owner's names
// for the three other Paul Mitchell sellers first; anyone else gets initials.
const SELLER_ABBR = [[/hypnotic/i, 'Hyp'], [/\bsd\s*school/i, 'SD'], [/salon\s*blissful/i, 'SB']];
function sellerAbbr(name, isUs) {
  if (isUs) return 'US';
  for (const [re, a] of SELLER_ABBR) if (re.test(name || '')) return a;
  const words = String(name || '').replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return (words.map(w => w[0]).join('').slice(0, 3) || '?').toUpperCase();
}

// A seller's units on a listing: listing units × their Buy Box % (so every
// seller is measured against the same listing total), else their revenue ÷
// offer price.
function sellerUnitsOn(listingUnits, row) {
  if (row.buyBoxPct != null && listingUnits != null) return listingUnits * row.buyBoxPct / 100;
  return row.sellerUnits ?? null;
}

module.exports = { parseCsv, parseSmartScout, pieFor, mergeRows, sellerFromFilename, sellerKey, sellerAbbr, sellerUnitsOn, AMAZON_WIN_WHEN_IN_STOCK };

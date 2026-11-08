// BRAND FINDER (owner 11/8): brands Cosmoprof carries that are worth adding
// on Amazon. The owner's rule: the brand's listings let 3+ third-party
// sellers on, and the brand sells at least 100 a day. The brand list comes
// from Cosmoprof (pasted, or copied by Claude in Chrome on the owner's
// computer, since the site needs their login); Keepa answers the rest.
// Pure: no database or network here.

// Pasted text → brand names: one per line or comma-separated, counts and
// bullets stripped ("Paul Mitchell (312)", "• Redken"), duplicates dropped
// case-insensitively, first spelling kept.
function parseBrands(text) {
  const seen = new Set(), out = [];
  // counts first: "(1,204)" holds a comma that would split the line
  for (let raw of String(text || '').replace(/\(\s*\d[\d,]*\s*\)/g, '').split(/[\n\r,;]+/)) {
    let b = raw.replace(/^[\s•\-–*·\d.)]+(?=[A-Za-z])/, '').replace(/\s*\(\s*\d[\d,]*\s*\)\s*$/, '').replace(/\s+/g, ' ').trim();
    if (b.length < 2 || b.length > 60) continue;
    if (/^(brands?|shop all|view all|all brands|a-z|new|sale)$/i.test(b)) continue;
    const k = b.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(b);
  }
  return out;
}

// Third-party sellers on one listing: Keepa's new-offer count less Amazon
// when Amazon has an offer of its own.
function thirdPartySellers(p) {
  if (!p || p.offerCount == null) return null;
  return Math.max(0, p.offerCount - (p.amazonSelling ? 1 : 0));
}

// One brand's listings (Keepa products, keepa.js simplify) → its score.
// A listing is OPEN when it has minSellers+ third-party sellers. Units a day
// come from Amazon's "bought in past month" figure (a floor; Amazon shows
// none under ~50 a month, so a listing without it counts as 0, never a
// guess). The brand qualifies when its open listings together sell
// minPerDay+ a day.
function scoreBrand(brand, products, opt) {
  const o = Object.assign({ minSellers: 3, minPerDay: 100 }, opt || {});
  const want = String(brand || '').toLowerCase();
  // Keepa's brand filter is loose: keep only listings whose brand matches
  const mine = (products || []).filter(p => p && (!p.brand || p.brand.toLowerCase() === want || p.brand.toLowerCase().includes(want) || want.includes(p.brand.toLowerCase())));
  const rows = mine.map(p => {
    const tp = thirdPartySellers(p), perDay = p.monthlySold > 0 ? p.monthlySold / 30 : 0;
    return { asin: p.asin, title: p.title, image: p.image, price: p.buyBoxPrice, rank: p.salesRank, monthlySold: p.monthlySold, perDay: Math.round(perDay * 10) / 10,
      thirdParty: tp, amazonSelling: !!p.amazonSelling, open: tp != null && tp >= o.minSellers };
  }).sort((a, b) => b.perDay - a.perDay || (a.rank || 1e9) - (b.rank || 1e9));
  const open = rows.filter(r => r.open);
  const openPerDay = Math.round(open.reduce((n, r) => n + r.perDay, 0) * 10) / 10;
  const allPerDay = Math.round(rows.reduce((n, r) => n + r.perDay, 0) * 10) / 10;
  const tps = open.map(r => r.thirdParty);
  return {
    brand, checked: rows.length, open: open.length, openPerDay, allPerDay,
    noFigure: rows.filter(r => !(r.monthlySold > 0)).length,
    avgSellers: tps.length ? Math.round(tps.reduce((n, x) => n + x, 0) / tps.length * 10) / 10 : null,
    amazonOn: rows.filter(r => r.amazonSelling).length,
    openRevenuePerDay: Math.round(open.reduce((n, r) => n + r.perDay * (r.price || 0), 0)),
    qualifies: open.length > 0 && openPerDay >= o.minPerDay,
    listings: rows.slice(0, 40),
  };
}

// Keepa Product Finder selection for one brand: listings with enough new
// offers, best sellers first. Only what the finder can filter on; the exact
// 3P count and sales come from the products afterwards.
function finderSelection(brand, opt) {
  const o = Object.assign({ minSellers: 3, perBrand: 30 }, opt || {});
  return { brand: [brand], current_COUNT_NEW_gte: o.minSellers, current_SALES_gte: 1, sort: [['current_SALES', 'asc']], perPage: Math.max(50, o.perBrand), page: 0 };
}

module.exports = { parseBrands, thirdPartySellers, scoreBrand, finderSelection };

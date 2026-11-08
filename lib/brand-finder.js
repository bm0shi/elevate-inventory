// BRAND FINDER (owner 11/8): brands Cosmoprof carries that are worth adding
// on Amazon. The owner's rule: the brand's listings let 3+ third-party
// sellers on, and the brand sells at least 100 a day. The brand list comes
// from Cosmoprof (pasted, or copied by Claude in Chrome on the owner's
// computer, since the site needs their login); Keepa and Amazon's offers
// answer the rest. Pure: no database or network here.

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

// SPELLINGS TO TRY (owner 11/8: "John Paul Mitchell Systems" found nothing —
// Amazon's brand is "Paul Mitchell"; Keepa's brand filter is an exact
// match). Cosmoprof's company names → the names Amazon listings carry:
// company suffixes dropped ("Professional(s)", "Systems", "Inc", "Hair
// Care"…), a leading "The" dropped, a coded first word kept alone ("K18",
// "ACTIIV"), the last two words of a 3+ word name ("Paul Mitchell"), plus a
// few known families and whatever the owner typed for the brand.
const SUFFIX = /\s+(professionals?|pro|systems?|inc\.?|co\.?|company|corp\.?|corporation|llc|ltd\.?|international|intl|usa|us|group|brands?|labs?|laboratories|products|cosmetics|beauty|salon|hair\s*care|haircare|hair\s*science|hairscience|hair|biomimetic|by\s+.+)$/i;
const KNOWN = {
  'john paul mitchell systems': ['Paul Mitchell', 'Tea Tree', 'Awapuhi Wild Ginger', 'MITCH', 'Paul Mitchell Neon', 'Paul Mitchell Clean Beauty'],
  'paul mitchell': ['Paul Mitchell', 'Tea Tree', 'Awapuhi Wild Ginger', 'MITCH'],
  'wella professionals': ['Wella', 'Wella Professionals', 'Wella Professional'],
  'loreal professionnel': ['L\'Oreal Professionnel', 'L\'Oreal Paris', 'L\'Oréal Professionnel'],
  "l'oreal professionnel": ['L\'Oreal Professionnel', 'L\'Oréal Professionnel'],
  'sebastian professional': ['Sebastian', 'Sebastian Professional'],
  'kenra professional': ['Kenra', 'Kenra Professional'],
  'k18 biomimetic hairscience': ['K18', 'K18 Biomimetic Hairscience'],
};
function brandVariants(name, extra) {
  const out = [], seen = new Set();
  const add = v => { v = String(v || '').replace(/\s+/g, ' ').trim(); const k = v.toLowerCase(); if (v.length >= 2 && !seen.has(k)) { seen.add(k); out.push(v); } };
  const base = String(name || '').trim();
  add(base);
  for (const x of (extra || [])) add(x);
  for (const x of (KNOWN[base.toLowerCase()] || [])) add(x);
  let s = base.replace(/^the\s+/i, '');
  add(s);
  for (let i = 0; i < 3 && SUFFIX.test(s); i++) { s = s.replace(SUFFIX, '').trim(); add(s); }
  const w = s.split(' ');
  if (w.length >= 3) add(w.slice(-2).join(' '));
  if (w.length >= 2 && (/\d/.test(w[0]) || /^[A-Z]{3,}$/.test(w[0]))) add(w[0]);
  return out;
}
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Does a listing's (or seller's) name belong to the brand? Normalized
// containment either way against any spelling of 4+ characters.
function matchesBrand(name, variants) {
  const n = norm(name); if (!n) return false;
  return (variants || []).some(v => { const x = norm(v); return x.length >= 4 ? (n.includes(x) || x.includes(n) && n.length >= 4) : n === x; });
}

// Third-party sellers on one listing from Keepa's new-offer count, less
// Amazon when Amazon has an offer of its own (when the real offers weren't read).
function thirdPartySellers(p) {
  if (!p || p.offerCount == null) return null;
  return Math.max(0, p.offerCount - (p.amazonSelling ? 1 : 0));
}

// One listing's units a day: Amazon's "bought in past month" ÷ 30, else
// Keepa's count of sales-rank drops in 30 days ÷ 30 (each drop is at least
// one sale, so it's a floor too; owner 11/8: listings without the badge
// counted as 0, Medicool read 29 of 30 at 0). → { perDay, est }.
function unitsPerDay(p) {
  if (p && p.monthlySold > 0) return { perDay: p.monthlySold / 30, est: false };
  if (p && p.rankDrops30 > 0) return { perDay: p.rankDrops30 / 30, est: true };
  return { perDay: 0, est: false };
}

// The brand selling on its own listings (owner 11/8: "I meant the actual
// brand selling on there"): from each read listing's real offers
// ({ asin: { sellers: [{ id, bb }] } }, Amazon's getItemOffers) and the
// sellers' names (Keepa), a seller whose name matches the brand. → { sells,
// sellers: [{ id, name, listings, buyBox }], checked }.
function brandSellers(offers, names, variants, amazonId) {
  const by = {}; let checked = 0;
  for (const o of Object.values(offers || {})) {
    if (!o || !Array.isArray(o.sellers)) continue;
    checked++;
    for (const s of o.sellers) {
      if (!s.id || s.id === amazonId) continue;
      const nm = (names || {})[s.id];
      if (!nm || !matchesBrand(nm, variants)) continue;
      const x = by[s.id] = by[s.id] || { id: s.id, name: nm, listings: 0, buyBox: 0 };
      x.listings++; if (s.bb) x.buyBox++;
    }
  }
  const sellers = Object.values(by).sort((a, b) => b.listings - a.listings);
  return { sells: sellers.length > 0, sellers, checked };
}

// One brand's listings (Keepa products, keepa.js simplify) → its score.
// A listing is OPEN with minSellers+ third-party sellers: from its real
// offers when read (sellers other than Amazon and the brand's own store),
// else Keepa's count. The brand qualifies when its open listings sell
// minPerDay+ a day together.
function scoreBrand(brand, products, opt, ctx) {
  const o = Object.assign({ minSellers: 3, minPerDay: 100 }, opt || {});
  const c = ctx || {}, variants = c.variants || [brand], offers = c.offers || {}, own = new Set(c.brandSellerIds || []), amazonId = c.amazonId || 'ATVPDKIKX0DER';
  const mine = (products || []).filter(p => p && (!p.brand || matchesBrand(p.brand, variants)));
  const rows = mine.map(p => {
    const real = offers[p.asin] && Array.isArray(offers[p.asin].sellers) ? offers[p.asin] : null;
    const tp = real ? real.sellers.filter(s => s.id !== amazonId && !own.has(s.id)).length : thirdPartySellers(p);
    const u = unitsPerDay(p);
    return { asin: p.asin, title: p.title, brandOnAmazon: p.brand || null, image: p.image, price: p.buyBoxPrice, rank: p.salesRank, monthlySold: p.monthlySold,
      perDay: Math.round(u.perDay * 10) / 10, est: u.est, thirdParty: tp, sellersRead: !!real,
      amazonSelling: real ? real.sellers.some(s => s.id === amazonId) : !!p.amazonSelling,
      brandSells: real ? real.sellers.some(s => own.has(s.id)) : null, open: tp != null && tp >= o.minSellers };
  }).sort((a, b) => b.perDay - a.perDay || (a.rank || 1e9) - (b.rank || 1e9));
  const open = rows.filter(r => r.open);
  const sum = list => Math.round(list.reduce((n, r) => n + r.perDay, 0) * 10) / 10;
  const tps = open.map(r => r.thirdParty);
  return {
    brand, checked: rows.length, open: open.length, openPerDay: sum(open), allPerDay: sum(rows),
    estimated: rows.filter(r => r.est).length, noFigure: rows.filter(r => !(r.perDay > 0)).length,
    avgSellers: tps.length ? Math.round(tps.reduce((n, x) => n + x, 0) / tps.length * 10) / 10 : null,
    amazonOn: rows.filter(r => r.amazonSelling).length,
    amazonBrands: [...new Set(rows.map(r => r.brandOnAmazon).filter(Boolean))].slice(0, 6),
    openRevenuePerDay: Math.round(open.reduce((n, r) => n + r.perDay * (r.price || 0), 0)),
    qualifies: open.length > 0 && sum(open) >= o.minPerDay,
    listings: rows.slice(0, 40),
  };
}

// Keepa Product Finder selection for one brand: any of its spellings,
// listings with enough new offers, best sellers first.
function finderSelection(brand, opt, variants) {
  const o = Object.assign({ minSellers: 3, perBrand: 30 }, opt || {});
  return { brand: (variants && variants.length ? variants : [brand]).slice(0, 12), current_COUNT_NEW_gte: o.minSellers, current_SALES_gte: 1, sort: [['current_SALES', 'asc']], perPage: Math.max(50, o.perBrand), page: 0 };
}

module.exports = { parseBrands, brandVariants, matchesBrand, thirdPartySellers, unitsPerDay, brandSellers, scoreBrand, finderSelection };

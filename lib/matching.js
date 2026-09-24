// Matching invoice descriptions to catalog products (suggestions and cross-checks). Pure functions.
// Moved out of server.js unchanged so it can be tested on its own
// (test/matching.test.js).

// ============================================================
// DESCRIPTION MATCHING
// Cosmoprof invoice descriptions are abbreviated ("AWAPUHI MOIST
// SHAMPOO 10.1"); our product names are full Amazon titles. Score by
// token overlap with prefix matching so abbreviations still hit, and
// weight numbers (sizes) heavily since they disambiguate variants.
// ============================================================
const MATCH_STOPWORDS = new Set(['OZ','FLOZ','FL','ML','THE','AND','BY','FOR','WITH','OF','A','AN','NEW','PACK','CT','EA','SIZE','INC','LLC']);

// Cosmoprof descriptions truncate the product name and glue the size onto it:
//   "PM TEA TREE COLORCARE CONDITIONLITER"   -> CONDITION + LITER
//   "PM TEA TREE HAIR & BODY MOISTUR10.14 OZ" -> MOISTUR + 10.14 OZ
//   "COLOR PROTECT SHAMPOO-33.8OZ-LI"         -> SHAMPOO + 33.8 OZ
// Left glued, the word CONDITIONER never appears as a token — which is exactly
// how a conditioner gets linked to a shampoo. Prise them apart, and translate
// Paul Mitchell's "LITER" into the 33.8 fl oz that Amazon titles actually use,
// so the size can do the job of separating variants.
function normalizeSizeTerms(str) {
  let s = String(str || '').toUpperCase();
  s = s.replace(/LITERS?|LTR/g, ' LITER ');
  s = s.replace(/([A-Z])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([A-Z])/g, '$1 $2');
  s = s.replace(/\bLITER\b/g, ' 33.8 ');
  return s;
}

function matchTokens(str) {
  return normalizeSizeTerms(str)
    .replace(/[^A-Z0-9.]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !MATCH_STOPWORDS.has(t));
}

// How well does one token list cover another?
function coverage(from, against) {
  if (!from.length || !against.length) return 0;
  let hit = 0;
  for (const ft of from) {
    const isNum = /^[0-9.]+$/.test(ft);
    let best = 0;
    for (const at of against) {
      if (at === ft) { best = isNum ? 1.6 : 1; break; }
      if (!isNum && ft.length >= 3 && (at.startsWith(ft) || ft.startsWith(at))) best = Math.max(best, 0.7);
    }
    hit += best;
  }
  return hit / from.length;
}

// Amazon titles here are "<product name>, <marketing copy>, <size>". The part
// before the first comma is the real product name, and it is what distinguishes
// "Tea Tree Special Shampoo" from "Tea Tree Special COLOR Shampoo".
function productHead(name) {
  const s = String(name || '');
  const head = s.split(',')[0];
  return head.length >= 6 ? head : s;
}

// Score BOTH directions:
//   forward — how much of the invoice description the product explains
//   reverse — how much of the product's own name the description accounts for
// Reverse is what punishes an extra discriminating word like COLOR. Combined
// with an F1 so a candidate must satisfy both to win.
function matchScore(desc, name) {
  const d = matchTokens(desc);
  const n = matchTokens(name);
  const h = matchTokens(productHead(name));
  if (!d.length || !n.length) return 0;
  const fwd = coverage(d, n);
  const rev = coverage(h, d);
  if (fwd <= 0 || rev <= 0) return 0;
  return (2 * fwd * rev) / (fwd + rev);
}

// Best candidate products for an unmapped invoice description.
// ============================================================
// SAFETY CROSS-CHECK
// The UPC -> ASIN assignment is the one step where a human can be wrong and
// nothing downstream disagrees — the resulting Cosmo link inherits the error
// and gets stamped "barcode-verified", which is false confidence rather than
// no confidence. So before accepting an assignment, compare the chosen product
// against the invoice wording on two axes that actually distinguish Paul
// Mitchell SKUs: product TYPE and SIZE.
// ============================================================
const PRODUCT_TYPES = ['CONDITIONER','SHAMPOO','TREATMENT','MOISTURIZER','POMADE','SERUM',
  'HAIRSPRAY','CREAM','WAX','GEL','FOAM','CLAY','PASTE','OIL','MASQUE','DETANGLER',
  'RINSE','LOTION','TONIC','PRIMER','BALM','SPRAY'];

// Known Paul Mitchell / Cosmoprof pack sizes. Restricting to these keeps stray
// numbers ("Pack of 1", "2-in-1") from being read as sizes.
const KNOWN_SIZES = new Set(['1.8','2.5','3','3.4','4.2','5.1','6.7','8.5','9','10.1','10.14','12','16.9','24','32','33.8','64','128']);

function detectTypes(str) {
  const s = ' ' + normalizeSizeTerms(str).replace(/[^A-Z0-9.]+/g, ' ') + ' ';
  const out = new Set();
  for (const t of PRODUCT_TYPES) {
    // Cosmoprof truncates: CONDITIONLITER -> CONDITION, MOISTUR10.14 -> MOISTUR
    for (let len = t.length; len >= Math.min(6, t.length); len--) {
      if (s.includes(' ' + t.slice(0, len))) { out.add(t); break; }
    }
  }
  return out;
}

function detectSizes(str) {
  const s = normalizeSizeTerms(str);
  const out = new Set();
  for (const raw of (s.match(/\d{1,3}(?:\.\d{1,2})?/g) || [])) {
    const norm = String(parseFloat(raw));
    if (KNOWN_SIZES.has(norm) || KNOWN_SIZES.has(raw)) out.add(KNOWN_SIZES.has(norm) ? norm : raw);
  }
  return out;
}

const inter = (a, b) => [...a].some(x => b.has(x));

// Compare an invoice description against a product name. Returns the reasons
// they look incompatible — empty array means nothing objectionable found.
function crossCheck(description, productName) {
  const warnings = [];
  const dT = detectTypes(description), pT = detectTypes(productName);
  if (dT.size && pT.size && !inter(dT, pT)) {
    warnings.push({
      kind: 'type',
      message: `The invoice says ${[...dT].join(' / ')} but this product is a ${[...pT].join(' / ')}.`
    });
  }
  const dS = detectSizes(description), pS = detectSizes(productName);
  if (dS.size && pS.size && !inter(dS, pS)) {
    warnings.push({
      kind: 'size',
      message: `The invoice says ${[...dS].join(' / ')} oz but this product is ${[...pS].join(' / ')} oz. (A "LITER" is 33.8 oz.)`
    });
  }
  return warnings;
}

// Suggest a product for an unmapped invoice description.
//
// Deliberately ALL-OR-NOTHING. Measured against the real catalog, a correct
// match scored 0.68 while a wrong one scored 0.67 — the score cannot separate
// right from wrong in the middle of the range, so any "% match" shown to a
// worker is a guess wearing a lab coat. We therefore return AT MOST ONE
// suggestion, and only when it is both strong in absolute terms and clearly
// ahead of second place. Everything else returns nothing, and the worker is
// told to scan a bottle (definitive) or search by hand (deliberate).
// Thresholds calibrated against the real catalog and real invoice text, not
// picked by feel. Measured: correct matches landed at 0.97/0.97/0.97/0.73/0.71/
// 0.64, while a WRONG match landed at 0.70 and an absent product at 0.43. A
// correct 0.64 sitting below a wrong 0.70 means the middle of the range cannot
// be trusted at all. Above 0.90 the sample was clean, so that is the bar.
// Everything below suggests NOTHING — scanning a bottle is the accurate answer,
// and a blank is far cheaper than a confident wrong guess on the floor.
const SUGGEST_MIN_SCORE = 0.90;


const SUGGEST_MIN_GAP   = 0.10;

function suggestProducts(desc, catalog) {
  const seen = new Set();
  const ranked = catalog
    .map(p => ({ asin: p.asin, name: p.name, sku: p.sku, image: p.image, location: p.location, score: matchScore(desc, p.name) }))
    .filter(x => { if (!x.asin || seen.has(x.asin)) return false; seen.add(x.asin); return true; })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return [];
  const top = ranked[0];
  const second = ranked[1] ? ranked[1].score : 0;

  if (top.score < SUGGEST_MIN_SCORE) return [];
  if (ranked.length > 1 && (top.score - second) < SUGGEST_MIN_GAP) return [];

  // No percentage is returned on purpose — the number implies a precision this
  // method does not have, and a worker will believe it.
  return [{ asin: top.asin, name: top.name, sku: top.sku, image: top.image, location: top.location, strong: true }];
}

module.exports = { MATCH_STOPWORDS, normalizeSizeTerms, matchTokens, coverage, productHead, matchScore, PRODUCT_TYPES, KNOWN_SIZES, detectTypes, detectSizes, inter, crossCheck, SUGGEST_MIN_SCORE, SUGGEST_MIN_GAP, suggestProducts };

// Search everything (the ⌘K box): turning what was typed into SQL patterns,
// and ranking product matches so the one you meant comes first.
// No database access here; server.js runs the queries.

// Words for "name contains every word", as ILIKE patterns. % and _ are
// escaped so "50%" or "x_1" match literally.
function terms(q) {
  const raw = String(q || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const words = raw ? raw.split(' ').filter(w => w.length > 0).slice(0, 6) : [];
  const like = s => '%' + s.replace(/[\\%_]/g, m => '\\' + m) + '%';
  return { raw, upper: raw.toUpperCase(), any: like(raw), words: words.map(like) };
}

// Higher is better. An exact code (ASIN, FNSKU, SKU, barcode) beats a name
// match; a name that starts with what was typed beats one that only
// contains it; then ones on the shelf, then shorter names.
function rankProduct(p, q, upcNorm) {
  const t = String(q || '').trim().toUpperCase();
  const up = v => String(v || '').toUpperCase();
  if (!t) return 0;
  if (up(p.asin) === t || up(p.fnsku) === t || up(p.sku) === t) return 1000;
  if (upcNorm && p.upc_norm && p.upc_norm === upcNorm) return 950;
  if (up(p.asin).startsWith(t) || up(p.fnsku).startsWith(t) || up(p.sku).startsWith(t)) return 800;
  const name = up(p.name);
  let s = 0;
  if (name.startsWith(t)) s = 600;
  else if (name.includes(t)) s = 500;
  else {
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length && words.every(w => name.includes(w))) s = 400;
    else if (up(p.asin).includes(t) || up(p.sku).includes(t) || up(p.fnsku).includes(t)) s = 300;
  }
  // Among name matches, one we actually have on the shelf is the likelier one.
  return s ? s - Math.min(99, Math.floor(name.length / 4)) + (Number(p.onhand) > 0 ? 40 : 0) : 0;
}

module.exports = { terms, rankProduct };

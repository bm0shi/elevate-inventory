// ============================================================
// PACK BOXES & 2D BOX LABELS (Ship to FBA → Pack boxes). Pure.
// Each box is scanned as it's packed, and its 2D barcode label is printed
// when it's closed, so labels go on as boxes go on the pallet (a label-all-
// at-the-end flow means unstacking the pallet). Replaces typing box
// contents into Seller Central SKU by SKU.
//
// Amazon's 2D box-content barcode: a PDF417 holding, character for character
// what Source Correct prints (owner 10/20, after the app's first 2D test
// shipment went missing at Amazon: "copy their format … to make sure no
// issues"; decoded from their label for FBA19TBD1Q01 box 147, a shipment
// Amazon received):
//   AMZN,PO:FBA19TBD1Q01,FNSKU:X003TH6D2B, QTY:6,EXPs:10-15-2029,
// i.e. a space before QTY, "EXPs:" with the date as MM-DD-YYYY, and every
// entry ending in a comma. It used to be Amazon's documented form
// (…,FNSKU:X,QTY:6,EXP:291015, no trailing comma). One entry per FNSKU; a box
// of several products repeats the entry (Source Correct's sample had one).
// PDF417 settings are in index.html (error correction level 6).
// ============================================================

const SHIPMENT_ID_RE = /^FBA[A-Z0-9]{6,12}$/;
const MAX_BOX_LB = 50;      // Amazon's standard box weight limit (heavier needs "team lift" handling)
const MAX_SKUS_LABEL = 20;  // what fits reliably on a 203/300 dpi thermal label

function normShipmentId(s) {
  const v = String(s || '').trim().toUpperCase();
  return SHIPMENT_ID_RE.test(v) ? v : null;
}

// items: [{ fnsku, qty, exp? (YYMMDD) }] → merged by FNSKU, qty > 0, FNSKU order kept.
function mergeItems(items) {
  const out = [], at = {};
  for (const it of items || []) {
    const f = String(it.fnsku || '').trim().toUpperCase(), q = parseInt(it.qty, 10);
    if (!f || !(q > 0)) continue;
    if (at[f] != null) out[at[f]].qty += q;
    else { at[f] = out.length; out.push({ fnsku: f, qty: q, exp: it.exp || null }); }
  }
  return out;
}

// → { text } or { error } (so a bad label is never printed).
function boxBarcode(shipmentId, items) {
  const sid = normShipmentId(shipmentId);
  if (!sid) return { error: 'Shipment ID should look like FBA18XRL8GV5.' };
  const m = mergeItems(items);
  if (!m.length) return { error: 'The box is empty.' };
  const bad = m.find(x => !/^[A-Z0-9]{10}$/.test(x.fnsku));
  if (bad) return { error: `${bad.fnsku} isn't an FNSKU (10 letters/numbers, e.g. X003EH4VQ1).` };
  if (m.length > MAX_SKUS_LABEL) return { error: `${m.length} different products in one box — a label holds ${MAX_SKUS_LABEL}. Split the box.` };
  const parts = m.map(x => `FNSKU:${x.fnsku}, QTY:${x.qty},` + (x.exp && /^\d{6}$/.test(x.exp) ? `EXPs:${expText(x.exp)},` : ''));
  return { text: `AMZN,PO:${sid},${parts.join('')}`, skus: m.length, units: m.reduce((n, x) => n + x.qty, 0) };
}

// Warnings shown before a box is closed (not blocking).
function boxWarnings(box) {
  const w = [];
  if (!(box.weight_lb > 0)) w.push('No weight entered.');
  else if (box.weight_lb > MAX_BOX_LB) w.push(`Over ${MAX_BOX_LB} lb — Amazon needs a "Team lift" label, or split it.`);
  if (!(box.len > 0 && box.wid > 0 && box.hgt > 0)) w.push('No box size entered.');
  else if (Math.max(box.len, box.wid, box.hgt) > 25) w.push('A side is over 25 in — Amazon oversize box rules apply.');
  return w;
}

// Amazon's box ID for box n of a shipment: FBA19R87QYJJ + U + 000001. Amazon
// numbers boxes 1, 2, 3… the same way, which is what lets the full label
// (box ID barcodes + 2D contents) print as each box is packed. The box
// numbers must therefore stay 1..N with no gaps — see /api/pack/boxes.
function boxId(shipmentId, n) {
  const sid = normShipmentId(shipmentId), k = parseInt(n, 10);
  if (!sid || !(k >= 1 && k <= 999999)) return null;
  return sid + 'U' + String(k).padStart(6, '0');
}

// Expiration typed as 2029-09-26, 9/26/2029, 09-26-2029 or 290926 → YYMMDD
// (the barcode's EXP format); null if it isn't a real date.
function normExp(v) {
  const t = String(v || '').trim();
  if (!t) return null;
  let y, m, d, x;
  if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [, y, m, d] = x;
  else if ((x = t.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/))) [, m, d, y] = x;
  else if ((x = t.match(/^(\d{2})(\d{2})(\d{2})$/))) { [, y, m, d] = x; y = '20' + y; }
  else return null;
  y = Number(String(y).length === 2 ? '20' + y : y); m = Number(m); d = Number(d);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return String(y).slice(2) + String(m).padStart(2, '0') + String(d).padStart(2, '0');
}
// YYMMDD → 09-26-2029 for the label text
const expText = (e) => (/^\d{6}$/.test(e || '') ? `${e.slice(2, 4)}-${e.slice(4, 6)}-20${e.slice(0, 2)}` : '');

// A product's usual case size from the boxes built of it (units in each
// single-product box). Every box used to overwrite case_qty, so one odd box
// of 11 turned a 12-per-case product into 11 per case everywhere (owner
// 10/28). Returns the size most boxes had when the saved one is rarer than
// that, else null (leave it). Ties go to the bigger size.
function usualCaseQty(boxQtys, current) {
  const n = {};
  for (const q of boxQtys || []) if (q > 0) n[q] = (n[q] || 0) + 1;
  const sizes = Object.keys(n).map(Number);
  if (!sizes.length) return null;
  const mode = sizes.sort((a, b) => (n[b] - n[a]) || (b - a))[0];
  if (current === mode) return null;
  // an odd box is the short last one, so a tie with a bigger size goes back to it
  const c = n[current] || 0;
  return c < n[mode] || (c === n[mode] && mode > current) ? mode : null;
}

module.exports = { normShipmentId, mergeItems, boxBarcode, boxWarnings, boxId, normExp, expText, usualCaseQty, MAX_BOX_LB, MAX_SKUS_LABEL };

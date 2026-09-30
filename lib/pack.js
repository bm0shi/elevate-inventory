// ============================================================
// PACK BOXES & 2D BOX LABELS (Ship to FBA → Pack boxes). Pure.
// Each box is scanned as it's packed, and its 2D barcode label is printed
// when it's closed, so labels go on as boxes go on the pallet (a label-all-
// at-the-end flow means unstacking the pallet). Replaces typing box
// contents into Seller Central SKU by SKU.
//
// Amazon's 2D box-content barcode: a PDF417 holding
//   AMZN,PO:<shipment ID>,FNSKU:<fnsku>,QTY:<n>[,EXP:YYMMDD],FNSKU:…,QTY:…
// (Amazon "2D barcode requirements"; same string as the open-source
// coltisor/amazon-label-generator). One entry per FNSKU. PDF417 settings are
// in index.html (error correction level 6, module width ≥ 0.020 in).
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
  const parts = m.map(x => `FNSKU:${x.fnsku},QTY:${x.qty}` + (x.exp && /^\d{6}$/.test(x.exp) ? `,EXP:${x.exp}` : ''));
  return { text: `AMZN,PO:${sid},${parts.join(',')}`, skus: m.length, units: m.reduce((n, x) => n + x.qty, 0) };
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
// ---- Box numbers the way Amazon numbers them ----
// Amazon numbers a shipment's boxes by seller SKU, A→Z (digits before
// letters), keeping our order within a SKU. The pilot's labels were numbered
// in the order the floor built them, and 18 of 26 needed new labels after
// Amazon renumbered them (3L-HCWL → 1-3, 6G-LRYZ → 4-5, … TT Color Cond. →
// 20-26). So each SKU gets a BLOCK of numbers, from the shipment's quantity
// and its units per box, and a box takes the next free number in its block:
// the floor still builds in any order and prints as it goes.
// items: shipment items [{ asin, msku, qty }]; built: closed one-product
// boxes [{ box_no, asin, units }]; perBox: { asin: units per box } for the
// products not finished yet. → { blocks: [{ asin, msku, qty, perBox, boxes,
// start, end }], total, missing: [asin] } (missing: no units per box and
// not finished — every block after it can't be placed yet).
const skuCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function skuBlocks(items, built, perBox) {
  const by = {};
  for (const i of items || []) {
    if (!i.asin || !i.msku) continue;
    const x = by[i.msku] = by[i.msku] || { asin: i.asin, msku: i.msku, qty: 0 };
    x.qty += Number(i.qty) || 0;
  }
  const blocks = [], missing = [];
  let next = 1;
  for (const x of Object.values(by).sort((a, b) => skuCmp(a.msku, b.msku))) {
    const mine = (built || []).filter(b => b.asin === x.asin);
    const units = mine.reduce((t, b) => t + (Number(b.units) || 0), 0);
    const left = Math.max(0, x.qty - units), per = Number((perBox || {})[x.asin]) || 0;
    if (left > 0 && !(per > 0)) missing.push(x.asin);
    const boxes = mine.length + (left > 0 && per > 0 ? Math.ceil(left / per) : 0);
    blocks.push({ ...x, perBox: per || null, boxes, start: next, end: next + boxes - 1 });
    next += boxes;
  }
  return { blocks, total: next - 1, missing };
}
// Numbers for `count` new boxes of `asin`: the lowest free ones in its block.
// → { nos } or { error } (short: the block is full, i.e. more boxes than the
// shipment needs at that many per box).
function blockNumbers(plan, asin, count, used) {
  const b = plan.blocks.find(x => x.asin === asin);
  if (!b) return { error: 'not_in_shipment' };
  const u = new Set(used || []), nos = [];
  for (let n = b.start; n <= b.end && nos.length < count; n++) if (!u.has(n)) nos.push(n);
  return nos.length < count ? { error: 'block_full', nos, block: b } : { nos };
}
// Boxes whose number is outside their SKU's block (numbers given before a
// change in units per box, or before this numbering): they'd need new labels.
function blockMisfits(plan, built) {
  const at = {}; for (const b of plan.blocks) at[b.asin] = b;
  return (built || []).filter(b => { const k = at[b.asin]; return k && (b.box_no < k.start || b.box_no > k.end); }).map(b => b.box_no).sort((a, c) => a - c);
}

// YYMMDD → 09-26-2029 for the label text
const expText = (e) => (/^\d{6}$/.test(e || '') ? `${e.slice(2, 4)}-${e.slice(4, 6)}-20${e.slice(0, 2)}` : '');

module.exports = { skuBlocks, blockNumbers, blockMisfits, normShipmentId, mergeItems, boxBarcode, boxWarnings, boxId, normExp, expText, MAX_BOX_LB, MAX_SKUS_LABEL };

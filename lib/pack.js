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

module.exports = { normShipmentId, mergeItems, boxBarcode, boxWarnings, MAX_BOX_LB, MAX_SKUS_LABEL };

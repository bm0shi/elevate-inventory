// ============================================================
// CREATING SHIPMENTS FROM THE APP (Amazon Fulfillment Inbound v2024-03-20).
// Pure: builds the request bodies and reads Amazon's answers.
// "Pack later", the way Source Correct does it — the floor can't know the
// boxes before it starts building, so box contents go to Amazon at the END:
//   1 create the plan (products + quantities + ship-from)     free, cancellable
//   2 placement options (which warehouses, with a fee each)    viewing is free
//   3 confirm placement → FBA ID(s) + destination              placement fee is
//                                                             billed by Amazon
//   4 the floor builds and labels boxes in 2D Production, exactly as for a
//     Send to Amazon shipment (box numbers 1..N in build order), and finishes
//   5 box contents sent for each shipment (shipmentBoxesBody), then Amazon's
//     box numbers checked against the labels already on the boxes (checkBoxIds)
//   6 pallets (from the floor's own pallets) → partnered freight quotes
//   7 confirm freight                                         CHARGES the account
// The first version planned boxes up front (planBoxes / packingBody /
// pickAmazonBoxes below); shipments made that way keep working.
// ============================================================

// items: [{ msku, qty, perBox, len, wid, hgt, unitLb, exp? YYMMDD }] →
// boxes of perBox (the last one may be partial). Weight includes the box's
// cardboard and a bag per unit (pallet settings), like the pallet math.
function planBoxes(items, pk) {
  const boxLb = pk && pk.boxPackLb != null ? pk.boxPackLb : 1.5, bagLb = pk && pk.unitPackLb != null ? pk.unitPackLb : 0.05;
  const boxes = [], problems = [];
  let n = 0;
  for (const it of items || []) {
    const q = parseInt(it.qty, 10), per = parseInt(it.perBox, 10);
    if (!(q > 0)) continue;
    if (!(per > 0 && it.len > 0 && it.wid > 0 && it.hgt > 0 && it.unitLb > 0)) { problems.push(`${it.msku}: needs units per box, box size and unit weight.`); continue; }
    for (let left = q; left > 0; left -= per) {
      const u = Math.min(per, left);
      boxes.push({ box_no: ++n, items: [{ msku: it.msku, qty: u, ...(it.exp ? { exp: it.exp } : {}) }],
        weight_lb: Math.round((u * it.unitLb + boxLb + u * bagLb) * 100) / 100, len: +it.len, wid: +it.wid, hgt: +it.hgt });
    }
  }
  return { boxes, problems };
}

// Our ship-from (2D Production settings) + contact phone → Amazon's address.
function sourceAddress(from, contact) {
  const f = from || {}, c = contact || {};
  const miss = [];
  if (!f.name) miss.push('name'); if (!f.line1) miss.push('street'); if (!f.city) miss.push('city');
  if (!f.state) miss.push('state'); if (!f.zip) miss.push('ZIP'); if (!c.phone) miss.push('phone');
  if (miss.length) return { error: 'Ship-from address is missing: ' + miss.join(', ') + '. Set it in 2D Production → New shipment → Ship-from & contact.' };
  const a = { name: String(f.name).slice(0, 50), addressLine1: String(f.line1).slice(0, 180), city: String(f.city).slice(0, 30),
    stateOrProvinceCode: String(f.state).slice(0, 64), postalCode: String(f.zip).slice(0, 32), countryCode: String(f.country || 'US').slice(0, 2).toUpperCase(),
    phoneNumber: String(c.phone).replace(/[^\d+]/g, '').slice(0, 20) };
  if (f.line2) a.addressLine2 = String(f.line2).slice(0, 60);
  if (c.email) a.email = String(c.email).slice(0, 1024);
  return { address: a };
}

// items: [{ msku, qty, expiration? (YYYY-MM-DD) }]; one line per SKU.
function planBody({ name, items, source, marketplaceId, prepOwner, labelOwner }) {
  const merged = {};
  for (const it of items || []) {
    const k = String(it.msku || '').trim(); const q = parseInt(it.qty, 10);
    if (!k || !(q > 0)) continue;
    if (merged[k]) merged[k].quantity += q;
    else merged[k] = { msku: k, quantity: q, labelOwner: it.labelOwner || labelOwner || 'SELLER', prepOwner: it.prepOwner || prepOwner || 'NONE', ...(it.expiration ? { expiration: it.expiration } : {}) };
  }
  const list = Object.values(merged);
  if (!list.length) return { error: 'Add at least one product with a quantity.' };
  return { body: { destinationMarketplaces: [marketplaceId], items: list, sourceAddress: source, ...(name ? { name: String(name).slice(0, 40) } : {}) } };
}

// Box contents for Amazon, from the planned boxes. Every SKU belongs to one
// packing group (Amazon decides the groups); boxes with identical contents,
// size and weight are sent once with a quantity. Mixed boxes must stay
// within one group. groups: [{ packingGroupId, mskus: [..] }];
// boxes: [{ items: [{ msku, qty, exp? YYMMDD }], weight_lb, len, wid, hgt }].
function packingBody(groups, boxes, { prepOwner, labelOwner } = {}) {
  const groupOf = {};
  for (const g of groups || []) for (const m of g.mskus || []) groupOf[m] = g.packingGroupId;
  const byGroup = {}, problems = [];
  for (const b of boxes || []) {
    if (!(b.items && b.items.length)) continue;
    const gs = [...new Set(b.items.map(i => groupOf[i.msku]))];
    if (gs.includes(undefined)) { problems.push(`Box ${b.box_no}: ${b.items.filter(i => !groupOf[i.msku]).map(i => i.msku).join(', ')} isn't in this Amazon plan.`); continue; }
    if (gs.length > 1) { problems.push(`Box ${b.box_no} mixes products Amazon put in different packing groups — split it.`); continue; }
    if (!(b.weight_lb > 0 && b.len > 0 && b.wid > 0 && b.hgt > 0)) { problems.push(`Box ${b.box_no} has no weight or size.`); continue; }
    const items = b.items.map(i => ({ msku: i.msku, quantity: i.qty, labelOwner: labelOwner || 'SELLER', prepOwner: prepOwner || 'NONE',
      ...(i.exp && /^\d{6}$/.test(i.exp) ? { expiration: '20' + i.exp.slice(0, 2) + '-' + i.exp.slice(2, 4) + '-' + i.exp.slice(4, 6) } : {}) }))
      .sort((x, y) => x.msku.localeCompare(y.msku));
    const box = { contentInformationSource: 'BOX_CONTENT_PROVIDED',
      dimensions: { length: +b.len, width: +b.wid, height: +b.hgt, unitOfMeasurement: 'IN' },
      weight: { value: Math.round(b.weight_lb * 100) / 100, unit: 'LB' }, items };
    const key = JSON.stringify(box);
    const g = byGroup[gs[0]] = byGroup[gs[0]] || {};
    if (g[key]) g[key].quantity++; else g[key] = { ...box, quantity: 1 };
  }
  const packageGroupings = Object.entries(byGroup).map(([packingGroupId, m]) => ({ packingGroupId, boxes: Object.values(m) }));
  return { body: { packageGroupings }, problems };
}

// Planned vs boxed units per SKU: Amazon expects the boxes to hold the plan.
function boxedVsPlan(planItems, boxes) {
  const boxed = {};
  for (const b of boxes || []) for (const i of b.items || []) boxed[i.msku] = (boxed[i.msku] || 0) + i.qty;
  const rows = (planItems || []).map(p => ({ msku: p.msku, planned: p.qty, boxed: boxed[p.msku] || 0 }));
  for (const m of Object.keys(boxed)) if (!rows.find(r => r.msku === m)) rows.push({ msku: m, planned: 0, boxed: boxed[m] });
  return { rows, ok: rows.every(r => r.planned === r.boxed) };
}

// Amazon's placement options → what the owner picks from: warehouses count
// and the total fee (fees minus discounts).
function placementSummary(options) {
  const money = (arr) => (arr || []).reduce((t, f) => t + (Number(f.value && f.value.amount) || 0), 0);
  return (options || []).map(o => ({
    placementOptionId: o.placementOptionId, status: o.status, shipmentIds: o.shipmentIds || [], shipments: (o.shipmentIds || []).length,
    fee: Math.round((money(o.fees) - money(o.discounts)) * 100) / 100, expiration: o.expiration || null,
  })).sort((a, b) => a.fee - b.fee || a.shipments - b.shipments);
}

const pallet = require('./pallet');
const lb = (w) => !w ? 0 : String(w.unit || 'LB').toUpperCase().startsWith('K') ? w.value * 2.20462 : Number(w.value) || 0;
const inch = (v, u) => String(u || 'IN').toUpperCase().startsWith('C') ? v / 2.54 : Number(v) || 0;
// One shipment's boxes (Amazon's list, or ours) → { weight_lb, len, wid, hgt, units }.
function boxShape(b) {
  const d = b.dimensions || {};
  if (b.weight_lb != null) return b;
  return { weight_lb: lb(b.weight), len: inch(d.length, d.unitOfMeasurement), wid: inch(d.width, d.unitOfMeasurement), hgt: inch(d.height, d.unitOfMeasurement),
    units: (b.items || []).reduce((t, i) => t + (Number(i.quantity) || 0), 0), quantity: b.quantity || 1 };
}
// Stack the boxes onto pallets for the freight quote, with the same limits
// as the packing floor (lib/pallet.js: safe weight, 60" height, packaging).
// → [{ boxes, weight, height }] rounded up (lb, inches).
function palletize(boxes, s) {
  const S = pallet.settings(s), out = [];
  let cur = [];
  const flat = [];
  // Box weights sent to Amazon already include the cardboard and bags
  // (planBoxes); take them back out so palletStats doesn't count them twice.
  for (const b of boxes || []) {
    const x = boxShape(b);
    const net = { ...x, weight_lb: Math.max(0, x.weight_lb - S.boxPackLb - (x.units || 0) * S.unitPackLb) };
    for (let i = 0; i < (x.quantity || 1); i++) flat.push(net);
  }
  return stackPallets(flat, S);
}
// Net boxes ({ weight_lb = product only, units, len, wid, hgt }) in packing
// order → pallets, starting a new one when the next box wouldn't fit under
// the floor's limits. → [{ boxes, weight, height }] rounded up.
function stackPallets(flat, S) {
  const out = [];
  let cur = [];
  for (const b of flat) {
    const st = pallet.palletStats(cur, S);
    const fit = pallet.boxesThatFit(st, b, S);
    if (cur.length && fit.n != null && fit.n < 1) { out.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) out.push(cur);
  return out.map(p => { const st = pallet.palletStats(p, S); return { boxes: p.length, weight: Math.ceil(st.weight), height: Math.ceil(st.height) }; });
}
// Pallets GUESSED before anything is built, for a freight estimate on each
// destination option (split vs one warehouse). Per product: its saved case
// (units per box + box size) when there is one, else a standard 18×14×12
// carton filled to 80% of its volume with units of Amazon's package size.
// Weight is units × unit weight; packaging is added by the pallet math.
// lines: [{ msku, units, unitLb, cuft, perBox, len, wid, hgt }]
// → { pallets, missing: [msku without a weight] }
const EST_BOX = { len: 18, wid: 14, hgt: 12 };
function estimatePallets(lines, s) {
  const S = pallet.settings(s), flat = [], missing = [];
  for (const l of lines || []) {
    const u = parseInt(l.units, 10) || 0;
    if (!(u > 0)) continue;
    if (!(l.unitLb > 0)) { missing.push(l.msku); continue; }
    let per, dims;
    if (l.perBox > 0 && l.len > 0 && l.wid > 0 && l.hgt > 0) { per = +l.perBox; dims = { len: +l.len, wid: +l.wid, hgt: +l.hgt }; }
    else if (l.cuft > 0) { per = Math.max(1, Math.floor((EST_BOX.len * EST_BOX.wid * EST_BOX.hgt / 1728) * 0.8 / l.cuft)); dims = EST_BOX; }
    else { missing.push(l.msku); continue; }
    for (let left = u; left > 0; left -= per) { const n = Math.min(per, left); flat.push({ weight_lb: n * l.unitLb, units: n, ...dims }); }
  }
  return { pallets: stackPallets(flat, S), missing };
}
// Pallets in Amazon's shape (48 × 40 footprint), one entry per pallet.
function palletsBody(pallets, stackable) {
  return (pallets || []).filter(p => p.weight > 0 && p.height > 0).map(p => ({ quantity: 1, stackability: stackable ? 'STACKABLE' : 'NON_STACKABLE',
    dimensions: { length: 48, width: 40, height: Math.ceil(p.height), unitOfMeasurement: 'IN' }, weight: { value: Math.ceil(p.weight), unit: 'LB' } }));
}
// Amazon's freight options for one shipment → cheapest partnered first.
// Amazon lists the same carrier many times (the pilot: 9 × Central
// Transport at $144.59, 9 × Estes …), one per quote request kept on the plan,
// so the list is cut to one row per shipment + carrier + mode + solution: the
// cheapest, and of equal prices the one quoted last (latest expiration, then
// Amazon's list order).
function transportSummary(options) {
  const all = (options || []).map((o, i) => ({ ...o, _i: i }));
  const best = {};
  for (const o of all) {
    const k = [o.shipmentId, (o.carrier && (o.carrier.name || o.carrier.alphaCode)) || '', o.shippingMode || '', o.shippingSolution || ''].join('|');
    const c = o.quote && o.quote.cost ? Number(o.quote.cost.amount) : Infinity, e = (o.quote && o.quote.expiration) || '';
    const b = best[k];
    if (!b || c < b.c || (c === b.c && e >= b.e)) best[k] = { o, c, e };
  }
  return Object.values(best).map(x => x.o).sort((a, b) => a._i - b._i).map(o => ({
    transportationOptionId: o.transportationOptionId, shipmentId: o.shipmentId,
    carrier: (o.carrier && (o.carrier.name || o.carrier.alphaCode)) || '', mode: o.shippingMode || '', solution: o.shippingSolution || '',
    partnered: /PARTNERED/i.test(o.shippingSolution || ''), cost: o.quote && o.quote.cost ? Math.round(Number(o.quote.cost.amount) * 100) / 100 : null,
    expiration: o.quote && o.quote.expiration || null, voidableUntil: o.quote && o.quote.voidableUntil || null, preconditions: o.preconditions || [],
  })).sort((a, b) => (b.partnered - a.partnered) || ((a.cost ?? 1e9) - (b.cost ?? 1e9)));
}
// Amazon's box list for a confirmed shipment → which box number holds what.
// Box IDs end in U + 6 digits (FBA19R908TWYU000007 → 7); if Amazon ever
// omits them, its list order is used. mskuToAsin maps the seller SKU back.
function amazonBoxMap(boxes, mskuToAsin) {
  return (boxes || []).map((b, i) => {
    const m = String(b.boxId || '').match(/U(\d{6})$/);
    const items = (b.items || []).map(it => ({ msku: it.msku, asin: (mskuToAsin || {})[it.msku] || null, qty: Number(it.quantity) || 0 }));
    return { box_no: m ? parseInt(m[1], 10) : i + 1, boxId: b.boxId || null, items };
  }).sort((a, b) => a.box_no - b.box_no);
}
// Which of Amazon's box numbers the floor should use for "N boxes of this
// product, Q units each": the lowest unused ones Amazon assigned to exactly
// that content. → { boxes: [..], short } (short = how many had no match).
function pickAmazonBoxes(map, asin, qtyPerBox, count, used) {
  const u = new Set(used || []);
  const free = (map || []).filter(b => !u.has(b.box_no) && b.items.length === 1 && b.items[0].asin === asin && b.items[0].qty === qtyPerBox).map(b => b.box_no);
  const boxes = free.slice(0, count);
  return { boxes, short: count - boxes.length };
}

// ---- Pack later ----
// Box info for ONE shipment after it's built, from 2D Production's boxes
// ({ box_no, items, weight_lb (product only), len, wid, hgt }), sent as 2D
// barcode: Amazon reads each box's contents from the 2D barcode on its label,
// so only size and weight go here (Amazon refuses an item list with
// BARCODE_2D). Sending the contents as a list instead (BOX_CONTENT_PROVIDED)
// ties them to Amazon's own box numbers — seller SKU A→Z — so labels printed
// as the boxes were built didn't match (the pilot needed 18 relabels).
// Weight adds the cardboard and bags like the pallet math (lib/pallet packedLb).
function shipmentBoxesBody(shipmentId, boxes, s) {
  const S = pallet.settings(s), problems = [];
  const list = (boxes || []).filter(b => b.items && b.items.length).sort((a, b) => a.box_no - b.box_no);
  list.forEach((b, i) => { if (b.box_no !== i + 1) problems.push(`Box numbers must run 1 to ${list.length} with no gaps — box ${i + 1} is missing.`); });
  const out = [];
  for (const b of list) {
    if (!(b.weight_lb > 0 && b.len > 0 && b.wid > 0 && b.hgt > 0)) { problems.push(`Box ${b.box_no} has no weight or size.`); continue; }
    const units = b.items.reduce((t, i) => t + (Number(i.qty) || 0), 0);
    out.push({ contentInformationSource: 'BARCODE_2D', quantity: 1,
      dimensions: { length: +b.len, width: +b.wid, height: +b.hgt, unitOfMeasurement: 'IN' },
      weight: { value: Math.round(pallet.packedLb({ weight_lb: b.weight_lb, units }, S) * 100) / 100, unit: 'LB' } });
  }
  if (problems.length) return { problems: [...new Set(problems)].slice(0, 10) };
  return { body: { packageGroupings: [{ shipmentId, boxes: out }] }, problems: [] };
}
// Amazon's box list vs the labels on our boxes: same number → same contents?
// ours: [{ box_no, items: [{ msku, qty }] }]; amz: listShipmentBoxes.
// → { ok, wrong: [box_no], missing: [box_no], extra: [box_no] }
function checkBoxIds(ours, amz) {
  const key = (items) => (items || []).map(i => (i.msku || '') + '×' + (Number(i.qty) || 0)).sort().join('|');
  const A = {}; for (const b of amazonBoxMap(amz)) A[b.box_no] = b;
  const wrong = [], missing = [], seen = new Set();
  for (const b of ours || []) {
    if (!(b.items && b.items.length)) continue;
    const a = A[b.box_no]; seen.add(b.box_no);
    if (!a) missing.push(b.box_no);
    else if (a.items.length && key(a.items) !== key(b.items)) wrong.push(b.box_no);
  }
  const extra = Object.keys(A).map(Number).filter(n => !seen.has(n));
  return { ok: !wrong.length && !missing.length && !extra.length, wrong, missing, extra };
}
// The floor's pallets (2D Production: every box on a numbered pallet, with
// any tape-measured height) → [{ pallet, boxes, weight, height }] for the
// freight quote, rounded up, same math as the floor screen.
function floorPallets(boxes, s, measured) {
  const by = {};
  for (const b of boxes || []) {
    if (!(b.items && b.items.length)) continue;
    const n = b.pallet_no || 1;
    (by[n] = by[n] || []).push({ weight_lb: Number(b.weight_lb) || 0, len: Number(b.len) || 0, wid: Number(b.wid) || 0, hgt: Number(b.hgt) || 0,
      units: b.items.reduce((t, i) => t + (Number(i.qty) || 0), 0) });
  }
  return Object.keys(by).map(Number).sort((a, b) => a - b).map(n => {
    const st = pallet.palletStats(by[n], s, (measured || {})[n] || null);
    return { pallet: n, boxes: by[n].length, weight: Math.ceil(st.weight), height: Math.ceil(st.height) };
  });
}

// Amazon refuses a plan when a product's prep (or label) owner isn't one it
// accepts for that product: "ERROR: 1S-RXVQ-W2YL requires prepOwner but NONE
// was assigned. Accepted values: [AMAZON, SELLER]". All prep and labelling is
// done by us, so SELLER is taken whenever Amazon accepts it, else what it
// does accept (NONE for a product that needs no prep). Our first real plan
// was refused this way. Matched against our own SKUs (they can contain
// spaces, e.g. "TTS 16.9"). → { msku: { prepOwner?, labelOwner? } } (empty
// if the message isn't about owners).
function ownerFixes(message, mskus) {
  const msg = String(message || ''), out = {};
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const k of mskus || []) {
    for (const field of ['prepOwner', 'labelOwner']) {
      const m = msg.match(new RegExp('(?:^|[\\s:"])' + esc(k) + ' (?:requires|does not require) ' + field + ' but (\\w+) was assigned\\.?\\s*Accepted values:\\s*\\[([^\\]]*)\\]'));
      if (!m) continue;
      const ok = m[2].split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
      const pick = ok.includes('SELLER') ? 'SELLER' : ok.includes('NONE') ? 'NONE' : ok[0];
      if (pick && pick !== m[1]) (out[k] = out[k] || {})[field] = pick;
    }
  }
  return out;
}

// Amazon's prep data (listPrepDetails → mskuPrepDetails) → the owners to send.
// All prep and labelling is done by us: a product that needs prep gets
// SELLER, one that doesn't gets NONE, unless Amazon only allows one owner.
// Products Amazon has no prep data for are left out (the plan's default,
// then the refusal fix in ownerFixes, covers them).
function ownersFromPrepDetails(details) {
  const out = {};
  for (const d of details || []) {
    if (!d || !d.msku) continue;
    const types = (d.prepTypes || []).map(t => String(t).toUpperCase()).filter(t => t !== 'ITEM_NO_PREP');
    const cat = String(d.prepCategory || '').toUpperCase();
    const pc = String(d.prepOwnerConstraint || '').toUpperCase(), lc = String(d.labelOwnerConstraint || '').toUpperCase();
    let prep;
    if (pc === 'NONE_ONLY') prep = 'NONE';
    else if (pc === 'AMAZON_ONLY') prep = 'AMAZON';
    else if (types.length) prep = 'SELLER';
    else if (cat === 'NONE' || (d.prepTypes || []).length) prep = 'NONE';
    const o = {};
    if (prep) o.prepOwner = prep;
    if (lc === 'NONE_ONLY') o.labelOwner = 'NONE'; else if (lc === 'AMAZON_ONLY') o.labelOwner = 'AMAZON';
    if (Object.keys(o).length) out[d.msku] = o;
  }
  return out;
}

// "FBA_INB_0180: ERROR: Expiration date required (There's an input error with
// the resource 'WP-N569-M1HX')" → the SKUs Amazon wants an expiration date
// for (second refusal on our first real plan).
function expiryNeeded(message, mskus) {
  const msg = String(message || '');
  if (!/expiration date required/i.test(msg)) return [];
  return (mskus || []).filter(k => msg.includes("'" + k + "'") || msg.includes('"' + k + '"'));
}

module.exports = { boxShape, planBoxes, sourceAddress, planBody, packingBody, boxedVsPlan, placementSummary, palletize, palletsBody, transportSummary, amazonBoxMap, pickAmazonBoxes,
  shipmentBoxesBody, checkBoxIds, floorPallets, ownerFixes, ownersFromPrepDetails, expiryNeeded, estimatePallets };

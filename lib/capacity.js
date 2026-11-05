// ============================================================
// FBA CAPACITY (Pending Prep capacity bar). Pure.
// Amazon caps what we can hold in cubic feet per storage type, and counts
// stock at Amazon PLUS open shipments against it. The limit itself isn't in
// the API (it's on Seller Central's Capacity Monitor), so the owner types it
// in each month; the app works out the usage from each listing's package
// size (Catalog Items API) × units, so queued prep can be checked BEFORE
// the work is done rather than after Amazon refuses the shipment.
// Dangerous goods (hazmat) sit in a separate storage type with its own limit.
// ============================================================

const TO_INCHES = { inches: 1, inch: 1, in: 1, centimeters: 1 / 2.54, centimeter: 1 / 2.54, cm: 1 / 2.54, millimeters: 1 / 25.4, mm: 1 / 25.4, feet: 12, foot: 12, ft: 12, meters: 39.3701, m: 39.3701 };

// One Catalog Items `dimensions` entry → cubic feet per unit, or null.
// Package dimensions are what Amazon stores; item dimensions are the fallback.
function cubicFeet(dim) {
  const s = sizeInches(dim);
  return s ? (s.l * s.w * s.h) / 1728 : null;
}
// The same size in inches, and whether it's the package or the item size
// (the dangerous-goods storage request shows it beside the cubic feet).
function sizeInches(dim) {
  if (!dim) return null;
  for (const which of ['package', 'item']) {
    const d = dim[which];
    if (!d || !d.length || !d.width || !d.height) continue;
    const inch = (x) => { const f = TO_INCHES[String(x.unit || 'inches').toLowerCase()]; return f && x.value > 0 ? x.value * f : null; };
    const l = inch(d.length), w = inch(d.width), h = inch(d.height);
    if (l && w && h) return { l, w, h, which };
  }
  return null;
}

// Dangerous-goods storage request (owner 10/30: Seller Support asked for
// "ASIN — volume per unit (Cu Ft) × number of units = total cubic feet").
// Pasted text → [{ asin, units, parts }]: each ASIN takes the first
// whole-number word after it (FNSKUs, sizes like 8.5 and names are skipped);
// an ASIN listed twice is added up and keeps its parts so it can be shown.
function parseAsinQty(text) {
  const words = String(text || '').split(/[\s,;|=:\u2013\u2014-]+/).filter(Boolean);
  const out = [], by = {};
  for (let i = 0; i < words.length; i++) {
    const a = words[i].toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/.test(a)) continue;
    let q = null;
    for (let j = i + 1; j < words.length && !/^B0[A-Z0-9]{8}$/i.test(words[j]); j++)
      if (/^\d{1,6}$/.test(words[j])) { q = Number(words[j]); break; }
    if (!q) continue;
    if (!by[a]) { by[a] = { asin: a, units: 0, parts: [] }; out.push(by[a]); }
    by[a].units += q; by[a].parts.push(q);
  }
  return out;
}

// STORAGE TYPES (owner 11/5: Amazon refused a plan with FBA_INB_0132
// "exceeds the allowed volume for AEROSOL storage" while Send to Amazon
// took 180 aerosols; flammables were approved to 100 cu ft but aerosols
// still had 10). Amazon's capacity has three buckets we hold: standard,
// flammable (the other dangerous goods) and aerosol, each with its own
// limit, and a plan over ANY of them is refused whole. The app keeps the
// three apart: 'standard' | 'hazmat' (flammable) | 'aerosol'.
const KINDS = ['standard', 'hazmat', 'aerosol'];
const KIND_LABEL = { standard: 'Standard', hazmat: 'Flammable', aerosol: 'Aerosol' };
// Amazon's storage-type words (the FBA inventory planning report's
// storage-type column, the same names as the Capacity Monitor) → our bucket.
// Anything that isn't aerosol or flammable is standard-size, oversize,
// apparel... all counted against the standard limit here. Unknown → null.
function storageKind(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return null;
  if (/aerosol/.test(t)) return 'aerosol';
  if (/flammable|hazmat|dangerous|danger/.test(t)) return 'hazmat';
  return 'standard';
}
// A hazmat product with no word from Amazon yet: hairspray, mousse and dry
// shampoo are aerosol cans; a pump spray with alcohol in it is flammable but
// not an aerosol, so plain "spray" is not enough. Only a guess, shown as one.
function guessAerosol(name) {
  return /aerosol|hairspray|hair spray|mousse|sculpting foam|styling foam|foam|dry shampoo|dry wash|freeze and shine|super spray|shine spray|texture spray|finishing spray|working spray|shaping spray/i.test(String(name || ''));
}
// Which bucket a product counts in, and who said so: the owner's own call
// (storage_type), else Amazon's report (storage_type_amz), else the hazmat
// flag with a name guess between flammable and aerosol, else standard.
function kindOf(p) {
  if (!p) return { kind: 'standard', source: 'none' };
  if (p.storage_type && KINDS.includes(p.storage_type)) return { kind: p.storage_type, source: 'manual' };
  const amz = storageKind(p.storage_type_amz);
  if (amz) return { kind: amz, source: 'amazon' };
  if (p.hazmat) return guessAerosol(p.name) ? { kind: 'aerosol', source: 'guess' } : { kind: 'hazmat', source: 'hazmat' };
  return { kind: 'standard', source: 'none' };
}

// rows: [{ cuft, units, kind | hazmat }] → { standard, hazmat, aerosol, missing }
// (cubic feet per storage type; missing = rows with units but no size).
function volumeOf(rows) {
  const out = { standard: 0, hazmat: 0, aerosol: 0, missing: 0 };
  for (const r of rows || []) {
    const u = Math.max(0, Number(r.units) || 0);
    if (!u) continue;
    if (!(r.cuft > 0)) { out.missing++; continue; }
    const k = KINDS.includes(r.kind) ? r.kind : (r.hazmat ? 'hazmat' : 'standard');
    out[k] += u * r.cuft;
  }
  return out;
}

// THE CHECK BEFORE A PLAN GOES TO AMAZON. items: [{ asin, name, qty }];
// cap: what /api/capacity knows — cuft {asin: cu ft per unit}, kind {asin:
// bucket}, kindSrc {asin: who said}, used {bucket: cu ft at Amazon + on the
// way}, limit {bucket: cu ft, or null}. → { problems: [text], over: [...],
// noLimit: [...], unsized: [...] }. A bucket over its limit, or aerosol
// units with no aerosol limit entered (that's the one Amazon refuses on),
// is a problem; each names the lines in that bucket biggest first with how
// many of each would fit in the room left, so the owner cuts the right line
// instead of guessing. Lines with no size can't be counted and are named.
function planFit(items, cap) {
  const C = cap || {}, cuft = C.cuft || {}, kind = C.kind || {}, src = C.kindSrc || {}, used = C.used || {}, limit = C.limit || {};
  const by = { standard: [], hazmat: [], aerosol: [] }, unsized = [];
  for (const i of items || []) {
    const q = Number(i.qty) || 0; if (!(q > 0)) continue;
    const k = KINDS.includes(kind[i.asin]) ? kind[i.asin] : 'standard';
    const cf = cuft[i.asin];
    const line = { asin: i.asin, name: i.name || i.asin, qty: q, kind: k, guessed: src[i.asin] === 'guess', cuft: cf > 0 ? cf : null, total: cf > 0 ? cf * q : 0 };
    by[k].push(line);
    if (!(cf > 0)) unsized.push(line);
  }
  const f1 = v => (Math.round(v * 10) / 10).toLocaleString('en-US');
  const name = l => `${String(l.name).slice(0, 60).replace(/[\s(,\-–·]+$/, '')} ×${l.qty}${l.guessed ? ' (aerosol is a guess from the name — set it on the line)' : ''}`;
  const problems = [], over = [], noLimit = [];
  for (const k of KINDS) {
    const lines = by[k]; if (!lines.length) continue;
    const add = lines.reduce((n, l) => n + l.total, 0);
    const lim = Number(limit[k]) > 0 ? Number(limit[k]) : null;
    const now = Number(used[k]) || 0;
    if (!lim) {
      // Only aerosol blocks without a limit: it's the small one Amazon
      // refuses on; a missing standard or flammable limit is just unchecked.
      if (k === 'aerosol') {
        noLimit.push({ kind: k, add, lines });
        problems.push(`AEROSOL storage: this plan has ${lines.reduce((n, l) => n + l.qty, 0)} aerosol units (${lines.map(name).join(', ')}) = ${f1(add)} cu ft, and your aerosol limit isn't entered, so it can't be checked before Amazon. Seller Central → Capacity Monitor → Aerosol "Maximum shipment" → tap Set room left here. (Aerosol storage is often only 10 cu ft.)`);
      }
      continue;
    }
    const room = lim - now, overBy = add - room;
    if (overBy <= 0.05) continue;
    const sorted = lines.slice().sort((a, b) => b.total - a.total);
    over.push({ kind: k, add, used: now, limit: lim, room, over: overBy, lines: sorted });
    const fit = l => l.cuft ? Math.max(0, Math.floor(Math.max(0, room) / l.cuft)) : null;
    problems.push(`${KIND_LABEL[k].toUpperCase()} storage: this plan adds ${f1(add)} cu ft but only ${f1(Math.max(0, room))} cu ft is free (Amazon allows ${f1(lim)}, ${f1(now)} is there or on the way) — OVER by ${f1(overBy)} cu ft. Amazon refuses the whole plan for this. `
      + sorted.map(l => `${name(l)} = ${f1(l.total)} cu ft${l.cuft ? ` (${fit(l)} would fit on their own)` : ' (no size on file, not counted)'}`).join('; ')
      + '. Cut these lines down or send them later.');
  }
  return { problems, over, noLimit, unsized, byKind: by };
}

// Our estimate vs what Seller Central showed: a ratio to scale our figures
// by, used only when it's recent and sane (0.5–2×); otherwise 1.
function calibration(ourUsed, amazonUsed) {
  if (!(ourUsed > 0) || !(amazonUsed > 0)) return 1;
  const r = amazonUsed / ourUsed;
  return r >= 0.5 && r <= 2 ? r : 1;
}

// Unit weight in pounds from a Catalog Items `dimensions` entry (package
// weight first, as it ships), or null. Used for box weights in 2D Production.
const TO_LB = { pounds: 1, pound: 1, lb: 1, lbs: 1, ounces: 1 / 16, ounce: 1 / 16, oz: 1 / 16, kilograms: 2.20462, kilogram: 2.20462, kg: 2.20462, grams: 0.00220462, gram: 0.00220462, g: 0.00220462 };
function unitWeightLb(dim) {
  if (!dim) return null;
  for (const which of ['package', 'item']) {
    const w = dim[which] && dim[which].weight;
    const f = w && TO_LB[String(w.unit || 'pounds').toLowerCase()];
    if (f && w.value > 0) return Math.round(w.value * f * 1000) / 1000;
  }
  return null;
}

module.exports = { cubicFeet, sizeInches, parseAsinQty, volumeOf, calibration, unitWeightLb, KINDS, KIND_LABEL, storageKind, guessAerosol, kindOf, planFit };

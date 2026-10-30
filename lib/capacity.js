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

// rows: [{ cuft, units, hazmat }] → { standard, hazmat, missing }
// (cubic feet per storage type; missing = rows with units but no size).
function volumeOf(rows) {
  const out = { standard: 0, hazmat: 0, missing: 0 };
  for (const r of rows || []) {
    const u = Math.max(0, Number(r.units) || 0);
    if (!u) continue;
    if (!(r.cuft > 0)) { out.missing++; continue; }
    out[r.hazmat ? 'hazmat' : 'standard'] += u * r.cuft;
  }
  return out;
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

module.exports = { cubicFeet, sizeInches, parseAsinQty, volumeOf, calibration, unitWeightLb };

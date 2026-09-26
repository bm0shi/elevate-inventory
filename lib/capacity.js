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
  if (!dim) return null;
  for (const which of ['package', 'item']) {
    const d = dim[which];
    if (!d || !d.length || !d.width || !d.height) continue;
    const inch = (x) => { const f = TO_INCHES[String(x.unit || 'inches').toLowerCase()]; return f && x.value > 0 ? x.value * f : null; };
    const l = inch(d.length), w = inch(d.width), h = inch(d.height);
    if (l && w && h) return (l * w * h) / 1728;
  }
  return null;
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

module.exports = { cubicFeet, volumeOf, calibration };

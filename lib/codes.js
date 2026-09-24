// Barcode, rack-location and quantity rules shared by the scanner screens. Pure.
// Moved out of server.js unchanged so it can be tested on its own
// (test/codes.test.js).

// Largest quantity one action may move. A barcode scanned into a qty box
// (012345678905) used to be taken as the quantity; nothing real is this big.
const MAX_QTY = 5000;


function badQty(q) { return !Number.isInteger(q) || q < 1 || q > MAX_QTY; }

// Normalize a scanned/typed code so 12 vs 13 digit UPC/EAN variants of the SAME
// barcode match. Strips leading zeros for numeric codes; leaves ASIN/SKU alone.
function normCode(raw) {
  if (raw == null) return '';
  let c = String(raw).trim();
  // numeric barcodes: strip leading zeros so 009531136929 == 9531136929 == 0009531136929
  if (/^[0-9]+$/.test(c)) {
    c = c.replace(/^0+/, '');
  }
  return c.toUpperCase();
}

// ============================================================
// PALLET LOCATIONS
// Fixed rack map: A-1..A-20 (duo-compatible) and B-1..B-20 (singles).
// Extend LOC_ROWS to add more rows/positions later.
// ============================================================
const LOC_ROWS = { A: 20, B: 20 };


const LOCATION_SLOTS = [];
for (const row of Object.keys(LOC_ROWS)) {
  for (let i = 1; i <= LOC_ROWS[row]; i++) LOCATION_SLOTS.push(row + '-' + i);
}

// Accepts a1, A1, a-1, "A - 1" -> "A-1". Returns null if outside the rack map.
function normLoc(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^([A-Z])-?(\d{1,3})$/);
  if (!m) return null;
  const slot = m[1] + '-' + parseInt(m[2], 10);
  return LOCATION_SLOTS.includes(slot) ? slot : null;
}

module.exports = { normCode, LOC_ROWS, LOCATION_SLOTS, normLoc, MAX_QTY, badQty };

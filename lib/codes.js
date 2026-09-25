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
// Rack map: rows of numbered positions (A-1..A-20, B-1..B-20 by default —
// the first warehouse). The owner sets the real layout in Admin → Item
// Locations (setRackLayout, saved in inv_cache 'rack_layout'). LOC_ROWS and
// LOCATION_SLOTS are changed in place so every module holding them sees
// the new layout.
// ============================================================
const LOC_ROWS = { A: 20, B: 20 };
const LOCATION_SLOTS = [];
const MAX_POSITIONS = 200;

function rebuildSlots() {
  LOCATION_SLOTS.length = 0;
  for (const row of Object.keys(LOC_ROWS).sort()) {
    for (let i = 1; i <= LOC_ROWS[row]; i++) LOCATION_SLOTS.push(row + '-' + i);
  }
}
rebuildSlots();

// rows: { A: 30, B: 30, ... } — single letters, 1..MAX_POSITIONS each.
// Returns the cleaned layout, or throws on bad input.
function setRackLayout(rows) {
  const clean = {};
  for (const [k, v] of Object.entries(rows || {})) {
    const r = String(k).trim().toUpperCase();
    const n = parseInt(v, 10);
    if (!/^[A-Z]$/.test(r)) throw new Error('Row names are single letters (A–Z).');
    if (!(n >= 1 && n <= MAX_POSITIONS)) throw new Error('Row ' + r + ': positions must be 1–' + MAX_POSITIONS + '.');
    clean[r] = n;
  }
  if (!Object.keys(clean).length) throw new Error('Add at least one row.');
  for (const k of Object.keys(LOC_ROWS)) delete LOC_ROWS[k];
  Object.assign(LOC_ROWS, clean);
  rebuildSlots();
  return { ...LOC_ROWS };
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

// Slot order for sorting: row letter, then position number (A-2 before A-10).
function slotKey(loc) {
  const m = String(loc || '').match(/^([A-Z])-(\d+)$/);
  return m ? m[1].charCodeAt(0) * 1000 + parseInt(m[2], 10) : 1e9;
}

module.exports = { normCode, LOC_ROWS, LOCATION_SLOTS, normLoc, setRackLayout, slotKey, MAX_QTY, badQty };

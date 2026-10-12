// ============================================================
// REPRICER rules (Admin → Repricer; the scheduler is repricer.js).
// Brought over from the owner's separate amazon-pricing bot: during a time
// slot (e.g. 12:45–3:45 AM Arizona) every in-stock FBA listing where someone
// else holds the Buy Box drops by a flat amount, and the saved price goes
// back at the end of the slot.
//
// Arizona is UTC-7 all year (no daylight saving), so time math is a fixed
// offset. A slot may cross midnight; it must be 15 min to 12 hours long, and
// two switched-on slots may not overlap (a SKU's drop belongs to one slot).
// Pure functions only: no database, no Amazon.
// ============================================================
const AZ_MS = 7 * 3600 * 1000;
const DAY_MS = 86400000;
const MIN_LEN = 15, MAX_LEN = 12 * 60;
const STALE_HOURS = 24;
const PRICE_TOL = 0.01;
const MAX_SLOTS = 6;

const DEFAULTS = {
  enabled: false,               // arrives OFF: the old bot may still be running
  drop: 1.00,                   // $ off the live price
  minStock: 1,                  // sellable FBA units needed
  maxPct: 35,                   // safety cap: never take more than this % off
  exclude: [],                  // SKUs never dropped
  slots: [{ id: 's1', drop: '00:45', back: '03:45', on: true }],   // the old bot's window
};

function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}
const hhmm = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
function label(min) {
  const h = Math.floor(min / 60), mi = min % 60;
  return (h % 12 === 0 ? 12 : h % 12) + ':' + String(mi).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
}
const slotLen = (s) => (parseHHMM(s.back) - parseHHMM(s.drop) + 1440) % 1440;
const round2 = (n) => Math.round(n * 100) / 100;
const samePrice = (a, b) => a != null && b != null && Math.abs(a - b) <= PRICE_TOL;

// Two slots overlap when either one starts inside the other (on a 24 h clock).
function overlaps(a, b) {
  const as = parseHHMM(a.drop), bs = parseHHMM(b.drop);
  const inside = (t, s, len) => (t - s + 1440) % 1440 < len;
  return inside(bs, as, slotLen(a)) || inside(as, bs, slotLen(b));
}

// Clean up and check what the screen sends. Returns { ok, settings } or { ok:false, error }.
function checkSettings(input, prev) {
  const p = Object.assign({}, DEFAULTS, prev || {});
  const x = Object.assign({}, p, input || {});
  const drop = round2(parseFloat(x.drop));
  if (!(drop >= 0.01 && drop <= 50)) return { ok: false, error: 'The price drop must be between $0.01 and $50.' };
  const minStock = parseInt(x.minStock, 10);
  if (!(minStock >= 1 && minStock <= 10000)) return { ok: false, error: 'Minimum stock must be 1 or more.' };
  const maxPct = parseFloat(x.maxPct);
  if (!(maxPct >= 1 && maxPct <= 50)) return { ok: false, error: 'The safety cap must be between 1% and 50%.' };
  const exclude = [...new Set((Array.isArray(x.exclude) ? x.exclude : String(x.exclude || '').split(/[\s,]+/))
    .map(s => String(s).trim()).filter(Boolean))].slice(0, 500);
  const raw = Array.isArray(x.slots) ? x.slots : [];
  if (raw.length > MAX_SLOTS) return { ok: false, error: `At most ${MAX_SLOTS} time slots.` };
  // Keep each slot's id (its saved drops are filed under it); new ones get the next free sN.
  const used = new Set(), slots = [];
  const ids = raw.map(s => { const id = String((s && s.id) || ''); if (/^[a-z0-9]{1,12}$/i.test(id) && !used.has(id)) { used.add(id); return id; } return null; });
  for (const [i, s] of raw.entries()) {
    const d = parseHHMM(s && s.drop), b = parseHHMM(s && s.back);
    const n = 'Time slot ' + (i + 1);
    if (d == null || b == null) return { ok: false, error: `${n}: pick both times.` };
    const len = (b - d + 1440) % 1440;
    if (len < MIN_LEN) return { ok: false, error: `${n} is ${len} minutes long; it needs at least ${MIN_LEN}.` };
    if (len > MAX_LEN) return { ok: false, error: `${n} is ${Math.round(len / 6) / 10} hours long; 12 hours is the most.` };
    let id = ids[i];
    if (!id) { let k = 1; while (used.has('s' + k)) k++; id = 's' + k; used.add(id); }
    slots.push({ id, drop: hhmm(d), back: hhmm(b), on: s.on !== false });
  }
  const on = slots.filter(s => s.on);
  for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
    if (overlaps(on[i], on[j])) return { ok: false, error: `Time slots ${slotName(on[i])} and ${slotName(on[j])} overlap. Move one, or switch one off.` };
  }
  return { ok: true, settings: { enabled: x.enabled === true, drop, minStock, maxPct, exclude, slots } };
}
const slotName = (s) => label(parseHHMM(s.drop)) + '–' + label(parseHHMM(s.back));

// The run of a slot that most recently started at or before `now`.
// cycle = the Arizona date it started + the slot id ("2026-10-12/s1"):
// one drop per slot per night, and the key its saved prices are filed under.
function lastRun(slot, now) {
  const az = now - AZ_MS;
  let start = Math.floor(az / DAY_MS) * DAY_MS + parseHHMM(slot.drop) * 60000;
  if (start > az) start -= DAY_MS;
  const day = new Date(start).toISOString().slice(0, 10);
  return { slot, start: start + AZ_MS, end: start + AZ_MS + slotLen(slot) * 60000, cycle: day + '/' + slot.id };
}

// The switched-on slot we're inside right now, or null.
function activeRun(slots, now) {
  for (const s of slots || []) {
    if (!s.on) continue;
    const r = lastRun(s, now);
    if (now >= r.start && now < r.end) return r;
  }
  return null;
}

// The next switched-on slot to start after `now`, or null.
function nextRun(slots, now) {
  let best = null;
  for (const s of slots || []) {
    if (!s.on) continue;
    const r = lastRun(s, now);
    const start = r.start + DAY_MS, nx = { slot: s, start, end: start + slotLen(s) * 60000 };
    if (!best || nx.start < best.start) best = nx;
  }
  return best;
}

// The lowered price, or why not. The cap matters only for cheap items:
// $1 off a $2.50 item is 40%.
function dropPrice(original, amount, maxPct) {
  if (!(original > 0)) return { blocked: 'no live price' };
  const price = round2(original - amount);
  if (!(price > 0)) return { blocked: `the drop would reach $${price.toFixed(2)}` };
  const pct = amount / original * 100;
  if (pct > maxPct) return { blocked: `${pct.toFixed(1)}% off is over the ${maxPct}% cap` };
  return { price };
}

// What to do with a saved drop at restore time.
//  - Under 24 h old: put the saved price back. Sending it again is harmless
//    if the drop never landed, and a just-accepted drop may not show in the
//    listing yet, so the live price can't be trusted to say "already back".
//  - Older: read the live price first. Back at the original → nothing to do.
//    Still at the drop → put it back. Anything else → someone changed it by
//    hand since; leave it and say so.
function restoreAction(row, live, now) {
  const age = row.dropped_at ? now - new Date(row.dropped_at).getTime() : Infinity;
  if (age <= STALE_HOURS * 3600000) return { act: 'restore' };
  if (live == null) return { act: 'left_alone', note: 'no live price on Amazon' };
  if (samePrice(live, row.original_price)) return { act: 'cleared', note: 'already at the saved price' };
  if (samePrice(live, row.drop_price)) return { act: 'restore', note: 'stuck low from an earlier night' };
  return { act: 'left_alone', note: `Amazon shows $${live.toFixed(2)}; saved $${Number(row.original_price).toFixed(2)}, drop $${Number(row.drop_price).toFixed(2)}` };
}

// SKUs as typed by people (leading zeros lost in a spreadsheet) match Amazon's.
const skuKey = (sku) => { const s = String(sku || '').trim(); return /^\d+$/.test(s) ? s.replace(/^0+/, '') : s; };

module.exports = { DEFAULTS, STALE_HOURS, parseHHMM, label, slotLen, slotName, overlaps, checkSettings, lastRun, activeRun, nextRun, dropPrice, restoreAction, skuKey, samePrice };

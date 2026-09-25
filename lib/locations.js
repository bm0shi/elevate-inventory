// ============================================================
// SUGGESTED PALLET LOCATIONS (Admin → Item Locations). Pure.
// The owner's rule: keep a duo's two bottles next to each other — shampoo on
// A-6, its conditioner on A-7 — so a duo can be built from one spot.
//   1. Locations already assigned are kept, and are the anchors.
//   2. Bottles are grouped by duo: a shampoo in two duos (liter duo and a gift
//      set) links both partners, so they form one group laid out as a chain
//      where every pair is as close as possible.
//   3. A group with an anchor grows out from it, each bottle on the nearest
//      free spot in the same row as its partner.
//   4. A new group gets one unbroken run in a row, so it isn't split across
//      rows. Groups go first (by name, so product lines sit together), then
//      single bottles fill the next free spots, also by name.
// One product per spot. Whatever doesn't fit is returned as unplaced.
// ============================================================
const { slotKey } = require('./codes');

const rowOf = (s) => String(s).split('-')[0];
const posOf = (s) => parseInt(String(s).split('-')[1], 10);

// items: [{ asin, name, location }]   (physical bottles only, no duo listings)
// duos:  [{ components: [asin, asin, ...] }]
// slots: ordered slot names ('A-1', 'A-2', ...)
function planLocations(items, duos, slots) {
  const byAsin = {}; for (const it of items) byAsin[it.asin] = it;
  const name = (a) => String((byAsin[a] && byAsin[a].name) || a).toLowerCase();
  const slotSet = new Set(slots);
  const taken = new Set(items.map(i => i.location).filter(l => l && slotSet.has(l)));
  const where = {}; for (const it of items) if (it.location && slotSet.has(it.location)) where[it.asin] = it.location;
  const out = [];
  const place = (asin, loc, reason) => { where[asin] = loc; taken.add(loc); out.push({ asin, location: loc, reason }); };

  // duo partner graph between bottles we're placing
  const adj = {};
  for (const d of duos) {
    const cs = [...new Set((d.components || []).filter(a => byAsin[a]))];
    for (const a of cs) for (const b of cs) if (a !== b) (adj[a] = adj[a] || new Set()).add(b);
  }
  // connected groups
  const seen = new Set(), groups = [];
  for (const a of Object.keys(adj).sort((x, y) => name(x).localeCompare(name(y)))) {
    if (seen.has(a)) continue;
    const g = [], q = [a]; seen.add(a);
    while (q.length) { const x = q.shift(); g.push(x); for (const y of adj[x]) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    groups.push(chain(g, adj, name));
  }

  // nearest free spot in a row to a position (either side)
  const rowSlots = {};
  for (const s of slots) (rowSlots[rowOf(s)] = rowSlots[rowOf(s)] || []).push(s);
  const nearest = (loc) => {
    const r = rowOf(loc), p = posOf(loc);
    const free = (rowSlots[r] || []).filter(s => !taken.has(s));
    free.sort((x, y) => Math.abs(posOf(x) - p) - Math.abs(posOf(y) - p) || posOf(x) - posOf(y));
    return free[0] || null;
  };
  // first unbroken run of n free spots in any row
  const run = (n) => {
    for (const r of Object.keys(rowSlots).sort()) {
      const rs = rowSlots[r];
      for (let i = 0; i + n <= rs.length; i++) {
        let ok = true; for (let j = 0; j < n; j++) if (taken.has(rs[i + j])) { ok = false; break; }
        if (ok) return rs.slice(i, i + n);
      }
    }
    return null;
  };
  const firstFree = () => slots.find(s => !taken.has(s)) || null;
  const nm = (a) => (byAsin[a] && byAsin[a].name) || a;

  // groups with an anchor first, so new groups don't take the spots beside it
  groups.sort((g1, g2) => (g2.some(a => where[a]) - g1.some(a => where[a])));
  const unplaced = [];
  for (const g of groups) {
    const todo = g.filter(a => !where[a]);
    if (!todo.length) continue;
    if (todo.length === g.length) {
      const spots = run(g.length);
      if (spots) { g.forEach((a, i) => place(a, spots[i], i ? 'next to ' + nm(g[i - 1]) + ' (duo partner)' : 'duo group')); continue; }
    }
    // grow out from placed partners, closest links first
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of g) {
        if (where[a]) continue;
        const partner = [...adj[a]].find(b => where[b]);
        if (!partner) continue;
        const s = nearest(where[partner]);
        if (s) { place(a, s, 'next to ' + nm(partner) + ' (duo partner)'); progress = true; }
      }
    }
    // members with no placed partner yet (whole row full): start them anywhere
    for (const a of g) {
      if (where[a]) continue;
      const s = firstFree();
      if (!s) { unplaced.push(a); continue; }
      place(a, s, 'duo group (no room beside its partner)');
      for (const b of g) if (!where[b] && adj[b].has(a)) { const t = nearest(s); if (t) place(b, t, 'next to ' + nm(a) + ' (duo partner)'); }
    }
  }
  // single bottles, by name
  const singles = items.filter(i => !adj[i.asin] && !where[i.asin]).sort((x, y) => name(x.asin).localeCompare(name(y.asin)));
  for (const it of singles) {
    const s = firstFree();
    if (!s) { unplaced.push(it.asin); continue; }
    place(it.asin, s, 'single');
  }
  out.sort((x, y) => slotKey(x.location) - slotKey(y.location));
  return { assignments: out, unplaced };
}

// Order a group so partners sit next to each other: walk from an end (fewest
// partners), always stepping to an unvisited partner; if stuck, continue
// from a bottle that's partnered with one already laid out.
function chain(g, adj, name) {
  const left = new Set(g), order = [];
  const deg = (a) => [...adj[a]].filter(b => left.has(b)).length;
  const pick = (cands) => cands.sort((x, y) => deg(x) - deg(y) || name(x).localeCompare(name(y)))[0];
  let cur = pick([...left]);
  while (cur) {
    order.push(cur); left.delete(cur);
    const next = [...adj[cur]].filter(b => left.has(b));
    if (next.length) { cur = pick(next); continue; }
    const linked = [...left].filter(b => [...adj[b]].some(x => order.includes(x)));
    cur = linked.length ? pick(linked) : (left.size ? pick([...left]) : null);
  }
  return order;
}

module.exports = { planLocations };

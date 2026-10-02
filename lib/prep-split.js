// ============================================================
// LARGE PREP JOBS SPLIT IN HALF
// A Pending Prep job over SPLIT_OVER units is two linked halves (part 1 and
// part 2, same split_group) so two people can each take one and the speed
// chart sees each person's own work (one shared job gives both the same
// rate). Prepped & Ready stays one card per product, so the halves land
// together when finished.
// splitPlan says how to add q units to the open rows of one product:
//   existing: [{ id, qty, claimed, group, part }] (ordered by id)
// → { updates: [{ id, qty, group?, part? }], inserts: [{ qty, part?, group? }] }
// group 'new' on an insert = use the id of the first inserted row.
// Someone already working a half never has their job shrunk: added units go
// to the free half, or become the second half of a claimed job.
// ============================================================
const SPLIT_OVER = 200;
const halves = n => [Math.ceil(n / 2), Math.floor(n / 2)];

function splitPlan(existing, q, limit = SPLIT_OVER) {
  const rows = existing || [];
  if (!rows.length) {
    if (q <= limit) return { updates: [], inserts: [{ qty: q }] };
    const [a, b] = halves(q);
    return { updates: [], inserts: [{ qty: a, part: 1, group: 'new' }, { qty: b, part: 2, group: 'new' }] };
  }
  if (rows.length === 1) {
    const r = rows[0], total = r.qty + q;
    if (total <= limit) return { updates: [{ id: r.id, qty: total }], inserts: [] };
    if (!r.claimed) {
      const [a, b] = halves(total);
      return { updates: [{ id: r.id, qty: a, group: r.id, part: 1 }], inserts: [{ qty: b, part: 2, group: r.id }] };
    }
    return { updates: [{ id: r.id, qty: r.qty, group: r.id, part: 1 }], inserts: [{ qty: q, part: 2, group: r.id }] };
  }
  if (rows.length === 2 && rows[0].group != null && rows[0].group === rows[1].group) {
    const [r1, r2] = rows;
    if (!r1.claimed && !r2.claimed) {
      const [a, b] = halves(r1.qty + r2.qty + q);
      return { updates: [{ id: r1.id, qty: a }, { id: r2.id, qty: b }], inserts: [] };
    }
    if (r1.claimed !== r2.claimed) { const free = r1.claimed ? r2 : r1; return { updates: [{ id: free.id, qty: free.qty + q }], inserts: [] }; }
    const [a, b] = halves(q);
    return { updates: [{ id: r1.id, qty: r1.qty + a }, { id: r2.id, qty: r2.qty + b }], inserts: [] };
  }
  // Anything else (older duplicate rows): add to the first free one, as before
  const t = rows.find(r => !r.claimed) || rows[0];
  return { updates: [{ id: t.id, qty: t.qty + q }], inserts: [] };
}

module.exports = { SPLIT_OVER, splitPlan };

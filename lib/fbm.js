// FBM orders off warehouse stock (owner 11/4: "is there a way to see what
// items I sell FBM and deduct it from my prelabeled items or on hand, or do I
// need to manually do that" → "go back one week and remove it from anywhere:
// pending prep, prelabeled, on hand or prepped and ready").
//
// Every unit we ship ourselves leaves the shelf, so it comes off On Hand.
// Prepped & Ready, pre-labeled and Pending Prep are parts of On Hand set aside
// for something, so the sold unit is taken where it disturbs the least:
//   1. free stock (on hand not set aside for anything),
//   2. pre-labeled (labelled, not part of any shipment),
//   3. Pending Prep jobs of that listing (not built yet: pre-label jobs, then
//      the next batch, then open jobs, a job someone is working last),
//   4. Prepped & Ready (set aside for a shipment).
// Whatever isn't found anywhere is NOT taken off (the count would go below
// zero); it's reported so the count can be fixed by hand.
//
// planTake(need, { free, prelabel, pending: [{ id, qty }] in order, ready })
// → { free, prelabel, pending: [{ id, take }], ready, taken, short }.
function planTake(need, have) {
  let left = Math.max(0, Math.floor(Number(need) || 0));
  const take = (avail) => { const t = Math.max(0, Math.min(left, Math.floor(Number(avail) || 0))); left -= t; return t; };
  const out = { free: take(have.free), prelabel: take(have.prelabel), pending: [], ready: 0 };
  for (const j of (have.pending || [])) { const t = take(j.qty); if (t > 0) out.pending.push({ id: j.id, take: t }); }
  out.ready = take(have.ready);
  out.short = left;
  out.taken = Math.max(0, Math.floor(Number(need) || 0)) - left;
  return out;
}

// Where it came from, in words for the Activity log.
function takenText(p) {
  const pend = (p.pending || []).reduce((n, j) => n + j.take, 0);
  const parts = [];
  if (p.free) parts.push(p.free + ' from the shelf');
  if (p.prelabel) parts.push(p.prelabel + ' pre-labeled');
  if (pend) parts.push(pend + ' from Pending Prep');
  if (p.ready) parts.push(p.ready + ' from Prepped & Ready');
  return parts.join(', ');
}

module.exports = { planTake, takenText };

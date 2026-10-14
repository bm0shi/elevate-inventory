// ============================================================
// SPLIT DELIVERIES — one Cosmoprof invoice, several shipments (owner, 10/14:
// "Treat them as separate invoices. Like 6088(1) and 6088(2)").
//
// Cosmoprof ships a big invoice in pieces, each with its own slip and SHP#
// (shipment number), sometimes a week apart, sometimes never (backordered too
// long). So each delivery is checked in on its own, for what actually came:
// the first under the invoice number (262106088), later ones as parts
// (262106088-2, -3 …). Nothing waits on "the rest".
//
// planInvoiceWrite decides where an incoming slip / pasted invoice goes. The
// SHP# is the key that stops the same slip being added twice. Older rows (and
// text without a SHP#) have no key, so identical lines count as the same slip.
// Pure: server.js reads the parts and writes inside one locked transaction.
// ============================================================

const partName = (base, n) => (n <= 1 ? String(base) : `${base}-${n}`);
// '262106088-2' → 2; the invoice itself → 1
function partNo(orderNumber, base) {
  if (String(orderNumber) === String(base)) return 1;
  const m = /-(\d+)$/.exec(String(orderNumber));
  return m ? parseInt(m[1], 10) : 1;
}
// The same lines (item # × qty, any order) = the same slip.
const lineSig = (items) => (items || [])
  .map(i => String(i.cosmo_num) + 'x' + (i.qty_shipped ?? i.qty_expected ?? 0))
  .sort().join(',');

// base: the invoice number. key: this slip's SHP# ('' when unknown), or keys:
// several (an emailed invoice holding more than one shipment's pages).
// sig: lineSig of its lines. parts: what the app has for this invoice,
// [{ order_number, status, slips: [SHP#] | null, sig }].
// → { write: true, orderNumber, mode: 'create' | 'replace' }
//   { write: false, orderNumber, why: 'already' | 'same_lines' | 'pending_unkeyed' }
function planInvoiceWrite({ base, key, keys, sig, parts }) {
  parts = parts || [];
  const ks = (keys && keys.length) ? keys : (key ? [key] : []);
  const received = p => p.status === 'received';
  const keyed = p => Array.isArray(p.slips) && p.slips.length > 0;
  const newest = list => list.slice().sort((a, b) => partNo(b.order_number, base) - partNo(a.order_number, base))[0];
  const next = () => {
    if (!parts.length) return { write: true, orderNumber: partName(base, 1), mode: 'create' };
    const n = Math.max(...parts.map(p => partNo(p.order_number, base))) + 1;
    return { write: true, orderNumber: partName(base, n), mode: 'create' };
  };

  if (ks.length) {
    const mine = parts.find(p => keyed(p) && p.slips.some(k => ks.includes(k)));
    if (mine) return received(mine)
      ? { write: false, orderNumber: mine.order_number, why: 'already' }
      : { write: true, orderNumber: mine.order_number, mode: 'replace' };   // read again before check-in: a correction
    // an older row without a slip number that has exactly these lines is this slip
    const same = parts.find(p => !keyed(p) && p.sig === sig);
    if (same) return received(same)
      ? { write: false, orderNumber: same.order_number, why: 'same_lines' }
      : { write: true, orderNumber: same.order_number, mode: 'replace' };
    // waiting to be checked in with no slip number: this slip may already be
    // in it (a pasted invoice covering several slips), so don't guess
    const loose = parts.find(p => !received(p) && !keyed(p));
    if (loose) return { write: false, orderNumber: loose.order_number, why: 'pending_unkeyed' };
    return next();
  }

  // no slip number (pasted or emailed text without SHP#)
  const same = parts.find(p => p.sig === sig);
  if (same) return received(same)
    ? { write: false, orderNumber: same.order_number, why: 'same_lines' }
    : { write: true, orderNumber: same.order_number, mode: 'replace' };
  // re-pasting an invoice not yet checked in replaces it (fixing a paste, a
  // re-sent PDF), as it always has
  const loose = parts.filter(p => !received(p) && !keyed(p));
  if (loose.length) return { write: true, orderNumber: newest(loose).order_number, mode: 'replace' };
  return next();
}

// Plain words for a refused slip (staff read these; no prices).
function refusalText(plan, base, key) {
  const slip = key ? `Slip ${key}` : 'This invoice';
  if (plan.why === 'already') return `${slip} of invoice ${base} was already added as #${plan.orderNumber}. Nothing was added twice.`;
  if (plan.why === 'same_lines') return `${slip} has the same lines as #${plan.orderNumber}, already checked in. Nothing was added twice.`;
  if (plan.why === 'pending_unkeyed') return `#${plan.orderNumber} is waiting to be checked in and may already include ${key ? 'slip ' + key : 'these lines'}. Check it in first (a later delivery then becomes its own invoice), or delete it and add the slips again.`;
  return `${slip} was not added.`;
}

// Units a later delivery brings for items an earlier part of the same invoice
// came in short on: take them off what Cosmoprof "owes" there (oldest first),
// so the Shortages list doesn't ask for a credit on units that arrived.
// owed: [{ id, cosmo_num, qty_owed }] (earlier parts' lines, oldest first);
// got: [{ cosmo_num, qty }] → [{ id, take }]
function owedTakeoff(owed, got) {
  const left = new Map();
  for (const g of got || []) left.set(g.cosmo_num, (left.get(g.cosmo_num) || 0) + (g.qty || 0));
  const out = [];
  for (const o of owed || []) {
    const n = left.get(o.cosmo_num) || 0;
    if (n <= 0 || !(o.qty_owed > 0)) continue;
    const take = Math.min(n, o.qty_owed);
    out.push({ id: o.id, take });
    left.set(o.cosmo_num, n - take);
  }
  return out;
}

module.exports = { partName, partNo, lineSig, planInvoiceWrite, refusalText, owedTakeoff };

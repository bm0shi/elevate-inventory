// ============================================================
// OUR SHARE OF A LISTING'S SALES
// Keepa's "bought past month" is the whole listing: every seller, Amazon
// included. Planning from it (even halved when Amazon held the Buy Box)
// recommended 8,000+ Tea Tree Special Shampoo — 8–9 months of stock — on a
// listing where Amazon wins ~95% of the Buy Box and three other sellers split
// the rest with us. So Keepa demand is always scaled down to OUR share:
//   1. measured: our own sales ÷ Keepa's monthly, when we have both;
//   2. our Buy Box %: Keepa's 90-day per-seller Buy Box stats, read with our
//      seller id — the share we actually won;
//   3. estimated: the Buy Box Amazon doesn't win, split evenly between the
//      third-party sellers who actually won it (us included).
// Our own sales already are our share, so they're used as they are.
//
// Splitting by Keepa's offer count made the share far too small: it counts
// FBM and idle offers that never win the Buy Box, so a listing with 12
// offers left us ~0.4% and most bottles showed years of cover. Only sellers
// who won the Buy Box in the window count now; offer count is the fallback
// when there are no Buy Box stats, capped at MAX_SPLIT.
// ============================================================

const AMAZON_DEFAULT_PCT = 90; // Amazon holds the Buy Box now, but we have no 90-day figure yet
const MAX_SPLIT = 4;           // offer-count fallback: never split more ways than this

// m: the cached Keepa entry for the listing (may be empty).
// ourId: our Amazon seller id, when known.
// Returns { share (0..1), src: 'ourbb' | 'buybox' | 'guess' | null, amazonPct, sellers3P, ourPct }.
function estimateShare(m, ourId) {
  m = m || {};
  // Our own 90-day Buy Box %. Zero means we won none of it — often because we
  // were out of stock — so fall through to the split rather than plan on 0.
  const ourPct = (ourId && m.bbShares) ? (Number(m.bbShares[ourId]) || 0) : null;
  let amazonPct = m.amazonBuyBoxPct;
  if (ourPct > 0) {
    return { share: ourPct / 100, src: 'ourbb', amazonPct: amazonPct ?? null, sellers3P: m.buyBoxWinners3P ?? null, ourPct };
  }
  let src = 'buybox';
  if (amazonPct == null) {
    src = 'guess';
    amazonPct = m.amazonHasBuyBox ? AMAZON_DEFAULT_PCT : (m.amazonSelling ? 50 : 0);
  }
  amazonPct = Math.min(100, Math.max(0, Number(amazonPct) || 0));
  let sellers3P;
  if (m.buyBoxWinners3P != null) {
    // Winners in the window, plus us if we weren't one of them.
    const weWon = ourPct != null ? ourPct > 0 : false;
    sellers3P = Math.max(1, m.buyBoxWinners3P + (weWon ? 0 : 1));
  } else if (m.offerCount != null) {
    const amazonOffer = (m.amazonSelling || m.amazonHasBuyBox) ? 1 : 0;
    sellers3P = Math.min(MAX_SPLIT, Math.max(1, m.offerCount - amazonOffer));
  } else if (m.amazonBuyBoxPct != null || m.amazonHasBuyBox) {
    sellers3P = MAX_SPLIT;
  } else {
    return { share: null, src: null, amazonPct: null, sellers3P: null, ourPct };
  }
  return { share: ((100 - amazonPct) / 100) / sellers3P, src, amazonPct, sellers3P, ourPct };
}

// Our share measured from real sales: our units ÷ the listing's units, same
// period. Null when either side is missing or zero.
function measuredShare(ourMonthly, keepaMonthly) {
  if (!(ourMonthly > 0) || !(keepaMonthly > 0)) return null;
  return Math.min(1, ourMonthly / keepaMonthly);
}

// Products to Add: what WE could sell on a listing (owner's rule). The other
// sellers' SmartScout average shows what a seller really does on Amazon's
// leftovers (Amazon rarely changes); when we join, that same pie is split one
// more way, so their average shrinks by sellers/(sellers+1). Then 75% of that,
// to be safe. No seller files for the listing: the pie itself split with us
// in. carried: we already sell it, so we're already one of the sellers.
// Returns { units, src: 'peers' | 'pie' | null, split }.
const JOIN_SAFETY = 0.75;
function joinRate({ peerAvg, peerN, pie, sellers3P, carried, safety = JOIN_SAFETY }) {
  const n = Math.max(1, sellers3P || 0, peerN || 0);
  const split = carried ? n : n + 1;
  if (peerAvg != null && isFinite(peerAvg)) return { units: peerAvg * (n / split) * safety, src: 'peers', split };
  if (pie != null && isFinite(pie)) return { units: (pie / split) * safety, src: 'pie', split };
  return { units: null, src: null, split: null };
}

// Products to Add: what a competitor sells a month on a listing = the
// average of the seller files (ours included, all 4) that actually sell it.
// Amazon is never in them (they're third-party sellers). A seller with 0
// units on it (an offer that doesn't move, often ours on items we stopped
// selling) isn't counted, so it can't drag the average down.
function sellerAverage(sellerUnits) {
  const sold = (sellerUnits || []).filter(u => u != null && isFinite(u) && u > 0);
  return sold.length ? { avg: sold.reduce((t, u) => t + u, 0) / sold.length, n: sold.length } : { avg: null, n: 0 };
}

module.exports = { estimateShare, measuredShare, joinRate, sellerAverage, JOIN_SAFETY, AMAZON_DEFAULT_PCT, MAX_SPLIT };

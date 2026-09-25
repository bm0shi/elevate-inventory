// ============================================================
// OUR SHARE OF A LISTING'S SALES
// Keepa's "bought past month" is the whole listing: every seller, Amazon
// included. Planning from it (even halved when Amazon held the Buy Box)
// recommended 8,000+ Tea Tree Special Shampoo — 8–9 months of stock — on a
// listing where Amazon wins ~95% of the Buy Box and three other sellers split
// the rest with us. So Keepa demand is always scaled down to OUR share:
//   1. measured: our own sales ÷ Keepa's monthly, when we have both;
//   2. estimated: the Buy Box Amazon doesn't win, split evenly between the
//      third-party sellers on the listing (us included).
// Our own sales already are our share, so they're used as they are.
// ============================================================

const AMAZON_DEFAULT_PCT = 90; // Amazon holds the Buy Box now, but we have no 90-day figure yet

// m: the cached Keepa entry for the listing (may be empty).
// Returns { share (0..1), src: 'buybox' | 'guess' | null, amazonPct, sellers3P }.
function estimateShare(m) {
  m = m || {};
  let amazonPct = m.amazonBuyBoxPct;
  let src = 'buybox';
  if (amazonPct == null) {
    src = 'guess';
    amazonPct = m.amazonHasBuyBox ? AMAZON_DEFAULT_PCT : (m.amazonSelling ? 50 : 0);
  }
  amazonPct = Math.min(100, Math.max(0, Number(amazonPct) || 0));
  // Third-party sellers splitting what Amazon doesn't win. offerCount counts
  // every new offer (ours and Amazon's too); the Buy Box winners count is the
  // sellers who actually won it in 90 days. Take the larger — more sellers
  // means a smaller slice, which is the conservative side.
  const amazonOffer = (m.amazonSelling || m.amazonHasBuyBox || amazonPct > 0) ? 1 : 0;
  const fromOffers = m.offerCount != null ? m.offerCount - amazonOffer : null;
  const fromWinners = m.buyBoxWinners3P != null ? m.buyBoxWinners3P : null;
  if (fromOffers == null && fromWinners == null && m.amazonBuyBoxPct == null && !m.amazonHasBuyBox) {
    return { share: null, src: null, amazonPct: null, sellers3P: null };
  }
  const sellers3P = Math.max(1, fromOffers || 0, fromWinners || 0);
  return { share: ((100 - amazonPct) / 100) / sellers3P, src, amazonPct, sellers3P };
}

// Our share measured from real sales: our units ÷ the listing's units, same
// period. Null when either side is missing or zero.
function measuredShare(ourMonthly, keepaMonthly) {
  if (!(ourMonthly > 0) || !(keepaMonthly > 0)) return null;
  return Math.min(1, ourMonthly / keepaMonthly);
}

module.exports = { estimateShare, measuredShare, AMAZON_DEFAULT_PCT };

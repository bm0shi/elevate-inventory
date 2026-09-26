// ============================================================
// REAL CHECK-IN TIMES (Admin → Shipments, and Send Next's "Amazon check-in
// days"). Days from when a shipment was sent (created in the app) to when
// Amazon started receiving it (the check-in sync saw it). Pure.
// The typical figure is the MEDIAN of the last 10, so one shipment stuck at
// a far warehouse doesn't drag every plan out.
// ============================================================

const DAY = 86400000;

function checkinDays(createdAt, receivedAt) {
  const a = Date.parse(createdAt), b = Date.parse(receivedAt);
  if (!isFinite(a) || !isFinite(b) || b < a) return null;
  return (b - a) / DAY;
}

// ships: [{ created_at, received_at }] newest first → { typical, n, min, max }
function checkinStats(ships, last = 10) {
  const d = (ships || []).map(s => checkinDays(s.created_at, s.received_at)).filter(x => x != null).slice(0, last);
  if (!d.length) return { typical: null, n: 0, min: null, max: null };
  const s = [...d].sort((x, y) => x - y), m = s.length >> 1;
  const typical = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return { typical, n: d.length, min: s[0], max: s[s.length - 1] };
}

module.exports = { checkinDays, checkinStats };

const test = require('node:test');
const assert = require('node:assert');
const { checkinDays, checkinStats } = require('../lib/checkin');
const { asciiHeader } = require('../lib/notify');

test('days from sent to checked in', () => {
  assert.strictEqual(checkinDays('2026-09-01T12:00:00Z', '2026-09-10T12:00:00Z'), 9);
  assert.strictEqual(checkinDays('2026-09-10T00:00:00Z', '2026-09-01T00:00:00Z'), null);
  assert.strictEqual(checkinDays(null, '2026-09-01'), null);
});

test('typical check-in is the median of the last 10, so one slow shipment does not skew it', () => {
  const s = (d) => ({ created_at: '2026-08-01T00:00:00Z', received_at: new Date(Date.parse('2026-08-01T00:00:00Z') + d * 86400000).toISOString() });
  const r = checkinStats([s(8), s(9), s(40), s(10), { created_at: 'x', received_at: null }]);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.typical, 9.5);
  assert.strictEqual(r.max, 40);
  assert.deepStrictEqual(checkinStats([]), { typical: null, n: 0, min: null, max: null });
});

test('alert titles are made header-safe', () => {
  assert.strictEqual(asciiHeader('📦 Shipment FBA1 checked in — 9 days'), 'Shipment FBA1 checked in  9 days');
});

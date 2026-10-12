const test = require('node:test');
const assert = require('node:assert');
const { personSeconds, prepSeconds, splitDollars } = require('../lib/labor-split');

test('person-seconds: a crew of two for the whole job counts twice the time', () => {
  const s = '2026-10-01T15:00:00Z';
  const row = { duration_sec: 3600, started_at: s, crew: [
    { employee: 'Ann', joined_at: s, left_at: '2026-10-01T16:00:00Z' },
    { employee: 'Ben', joined_at: '2026-10-01T15:30:00Z', left_at: '2026-10-01T16:00:00Z' }] };
  assert.strictEqual(personSeconds(row), 3600 + 1800);
  assert.strictEqual(personSeconds({ duration_sec: 900 }), 900);
});

test('prep seconds: median per product; a job left open overnight is skipped', () => {
  const r = prepSeconds([
    { asin: 'A', qty: 100, duration_sec: 3000 },   // 30 s/unit
    { asin: 'A', qty: 100, duration_sec: 4000 },   // 40 s/unit
    { asin: 'A', qty: 10, duration_sec: 86400 },   // left claimed overnight: skipped
    { asin: 'D', qty: 50, duration_sec: 6000 },    // duo: 120 s/unit
  ]);
  assert.strictEqual(r.A.sec, 35);
  assert.strictEqual(r.A.jobs, 2);
  assert.strictEqual(r.D.sec, 120);
});

test('split: slow products carry more, and the dollars add back up to the total', () => {
  const sec = { A: { sec: 30 }, D: { sec: 120 } };
  const units = { A: 300, D: 100, X: 100 }; // X has no timed job: gets the median (75 s)
  const s = splitDollars(1000, sec, units);
  assert.ok(s.byAsin.D > s.byAsin.A * 3.9 && s.byAsin.D < s.byAsin.A * 4.1);
  const total = Object.keys(units).reduce((n, a) => n + units[a] * s.byAsin[a], 0);
  assert.ok(Math.abs(total - 1000) < 1e-6);
  assert.strictEqual(splitDollars(null, sec, units), null);
  assert.strictEqual(splitDollars(1000, {}, units), null);
});

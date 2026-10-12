const test = require('node:test');
const assert = require('node:assert');
const { checks, errorBurst } = require('../lib/health');

// 2026-10-12 16:00 UTC = 9:00 AM Arizona
const NOW = Date.UTC(2026, 9, 12, 16, 0);
const base = {
  now: NOW, build: 'b1', uptimeMs: 3600e3, db: { ok: true, ms: 12, mb: 40 }, amazonCreds: true,
  amazonSyncLast: { at: new Date(NOW - 2.5 * 3600e3).toISOString(), trigger: 'daily', result: { errors: [] } },
  dailySyncDay: '2026-10-12', checkinsAt: new Date(NOW - 3600e3).toISOString(),
  autoRun: { started_at: new Date(NOW - 2 * 86400e3).toISOString(), finished_at: new Date(NOW - 2 * 86400e3).toISOString(), ok: true, steps: [] },
  smtp: true, backupLast: { at: new Date(NOW - 86400e3).toISOString(), sent: true, to: 'a@b.c', mb: 1.2 },
  alerts: { ntfy: true }, errors24h: 0,
};
const get = (r, k) => r.checks.find(c => c.key === k);

test('all healthy reads green', () => {
  const r = checks(base);
  assert.strictEqual(r.overall, 'good', JSON.stringify(r.checks.filter(c => c.state !== 'good')));
});

test('morning sync: missed today is red after 7 AM; before 6:30 it looks at yesterday', () => {
  assert.strictEqual(get(checks({ ...base, dailySyncDay: '2026-10-11' }), 'morning').state, 'bad');
  const early = Date.UTC(2026, 9, 12, 12, 0); // 5 AM Arizona
  assert.strictEqual(get(checks({ ...base, now: early, dailySyncDay: '2026-10-11' }), 'morning').state, 'good');
  const dueNow = Date.UTC(2026, 9, 12, 13, 40); // 6:40 AM
  assert.strictEqual(get(checks({ ...base, now: dueNow, dailySyncDay: '2026-10-11' }), 'morning').detail, 'Due now');
});

test('Amazon: a refused login is red, a slow report is amber', () => {
  const s = e => ({ ...base, amazonSyncLast: { ...base.amazonSyncLast, result: { errors: [e] } } });
  assert.strictEqual(get(checks(s('check-ins: Request failed with status code 401')), 'amazon').state, 'bad');
  assert.strictEqual(get(checks(s('invalid_grant: refresh token revoked')), 'amazon').state, 'bad');
  assert.strictEqual(get(checks(s('sales report: report timed out')), 'amazon').state, 'warn');
  assert.strictEqual(get(checks({ ...base, amazonCreds: false }), 'amazon').state, 'bad');
});

test('backup: failed or over a week old is red; no email set up is amber', () => {
  assert.strictEqual(get(checks({ ...base, backupLast: { at: base.backupLast.at, sent: false, error: 'SMTP auth' } }), 'backup').state, 'bad');
  assert.strictEqual(get(checks({ ...base, backupLast: { ...base.backupLast, at: new Date(NOW - 9 * 86400e3).toISOString() } }), 'backup').state, 'bad');
  assert.strictEqual(get(checks({ ...base, smtp: false }), 'backup').state, 'warn');
});

test('Sunday auto-run: a failed run names the failed steps', () => {
  const r = get(checks({ ...base, autoRun: { ...base.autoRun, ok: false, steps: [{ name: 'Settlements', ok: false }, { name: 'Velocity', ok: true }] } }), 'auto');
  assert.strictEqual(r.state, 'bad');
  assert.match(r.detail, /Settlements/);
  assert.doesNotMatch(r.detail, /Velocity/);
});

test('errors: none green, a few amber, many red; a burst is 5 in 15 minutes', () => {
  assert.strictEqual(get(checks({ ...base, errors24h: 3 }), 'errors').state, 'warn');
  assert.strictEqual(get(checks({ ...base, errors24h: 12 }), 'errors').state, 'bad');
  const t = [1, 2, 3, 4, 5].map(i => NOW - i * 60e3);
  assert.strictEqual(errorBurst(t, NOW), true);
  assert.strictEqual(errorBurst(t.slice(0, 4), NOW), false);
  assert.strictEqual(errorBurst(t.map(x => x - 3600e3), NOW), false);
});

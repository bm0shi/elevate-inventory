// App status (Admin → App status, owner's #10): turns what the server knows
// about its own jobs into one green / amber / red line each. No database
// access here; server.js gathers the inputs.
//
// state: 'good' | 'warn' | 'bad'. Each check says what to do when it isn't
// good, because the owner reads this, not a log.

const PHX_OFFSET = 7 * 3600 * 1000; // Arizona: always UTC-7
const H = 3600 * 1000, D = 24 * H;
const phxParts = ms => { const d = new Date(ms - PHX_OFFSET); return { day: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const age = (now, ts) => (ts ? now - new Date(ts).getTime() : null);
function ago(ms) {
  if (ms == null) return 'never';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}
// Amazon refusing the login reads differently from Amazon being slow.
const AUTH_RE = /\b(401|403)\b|unauthori[sz]ed|invalid_grant|invalid_client|access.?denied|refresh token/i;

function checks(x) {
  const now = x.now || Date.now();
  const out = [];
  const add = (key, label, state, detail, fix) => out.push({ key, label, state, detail, fix: state === 'good' ? '' : (fix || '') });

  add('server', 'Server', 'good', 'Running build ' + (x.build || '?') + ' · up ' + ago(x.uptimeMs).replace(' ago', ''));

  if (!x.db || !x.db.ok) add('db', 'Database', 'bad', 'Not answering' + (x.db && x.db.error ? ': ' + x.db.error : ''), 'Check the Postgres service in Railway.');
  else add('db', 'Database', x.db.ms > 800 ? 'warn' : 'good', 'Answered in ' + x.db.ms + ' ms' + (x.db.mb ? ' · ' + x.db.mb + ' MB' : ''), 'Slow database: usually passes; if it stays slow, check Railway.');

  // Amazon connection, from the last sync with Amazon.
  const sync = x.amazonSyncLast, errs = sync && sync.result && sync.result.errors ? sync.result.errors : [];
  if (!x.amazonCreds) add('amazon', 'Amazon connection', 'bad', 'Amazon keys are not set on the server', 'Add the AMAZON_* variables in Railway.');
  else if (x.amazonSyncRunning) add('amazon', 'Amazon connection', 'good', 'Syncing with Amazon now…');
  else if (!sync) add('amazon', 'Amazon connection', 'warn', 'No sync with Amazon yet', 'Tap Sync with Amazon on On Hand.');
  else if (errs.some(e => AUTH_RE.test(e))) add('amazon', 'Amazon connection', 'bad', 'Amazon refused the login (' + ago(age(now, sync.at)) + ')', 'The Amazon authorization may have expired: re-authorize the app in Seller Central and update AMAZON_REFRESH_TOKEN.');
  else if (errs.length) add('amazon', 'Amazon connection', 'warn', 'Last sync ' + ago(age(now, sync.at)) + ' had problems: ' + errs.join(' · ').slice(0, 220), 'Usually Amazon being slow; the next sync retries. If it repeats every day, look at the step named.');
  else add('amazon', 'Amazon connection', 'good', 'Last sync ' + ago(age(now, sync.at)) + ', no problems');

  // The 6:30 AM Arizona sync (caught up until noon).
  const p = phxParts(now), due = 6 * 60 + 30;
  const expect = p.mins >= due ? p.day : phxParts(now - D).day; // before 6:30 the last one due was yesterday's
  const ranExpected = x.dailySyncDay === expect;
  const dailySync = sync && sync.trigger === 'daily' ? sync : x.lastDailySync;
  if (ranExpected) {
    const e = dailySync && dailySync.result && dailySync.result.errors ? dailySync.result.errors : [];
    if (x.amazonSyncRunning && x.amazonSyncTrigger === 'daily') add('morning', 'Morning sync (6:30 AM)', 'good', 'Running now');
    else add('morning', 'Morning sync (6:30 AM)', e.length ? 'warn' : 'good', (expect === p.day ? 'Ran today' : 'Ran yesterday') + (e.length ? ' with problems: ' + e.join(' · ').slice(0, 200) : ''), 'See Amazon connection above.');
  } else if (p.mins >= due && p.mins < due + 30) add('morning', 'Morning sync (6:30 AM)', 'good', 'Due now');
  else add('morning', 'Morning sync (6:30 AM)', 'bad', "Didn't run " + (expect === p.day ? 'today' : 'yesterday') + (x.dailySyncDay ? ' (last: ' + x.dailySyncDay + ')' : ''), 'The server may have been down at 6:30. Tap Sync with Amazon on On Hand to catch up.');

  // Check-ins (every 2 hours, 8 AM to 8 PM Arizona)
  const ci = age(now, x.checkinsAt);
  if (ci == null) add('checkins', 'Shipment check-ins', 'warn', 'Not checked yet', 'Tap Sync with Amazon on On Hand.');
  else add('checkins', 'Shipment check-ins', ci > 30 * H ? 'bad' : ci > 6 * H && p.mins >= 10 * 60 && p.mins < 20 * 60 ? 'warn' : 'good', 'Checked ' + ago(ci), 'Check-ins run every 2 hours from 8 AM to 8 PM; a gap means the server was down or Amazon was refusing.');

  // Sunday auto-run
  const a = x.autoRun;
  if (x.autoEnabled === false) add('auto', 'Sunday auto-refresh', 'warn', 'Turned off', 'Turn it back on in Admin → Data Sources.');
  else if (!a) add('auto', 'Sunday auto-refresh', 'warn', 'Has not run yet', 'It runs Sundays at 11:59 PM Arizona.');
  else if (!a.finished_at && age(now, a.started_at) < 3 * H) add('auto', 'Sunday auto-refresh', 'good', 'Running now');
  else if (a.ok === false || !a.finished_at) {
    const failed = (a.steps || []).filter(s => s && s.ok === false).map(s => s.name || s.step || '?');
    add('auto', 'Sunday auto-refresh', 'bad', 'Last run ' + ago(age(now, a.started_at)) + ' failed' + (failed.length ? ': ' + failed.join(', ') : ''), 'It retries every 3 hours; or run it from Admin → Data Sources.');
  } else add('auto', 'Sunday auto-refresh', age(now, a.finished_at) > 8 * D ? 'warn' : 'good', 'Last run ' + ago(age(now, a.finished_at)) + ', all steps done', 'More than a week since the last run: check it is turned on.');

  // Sunday backup
  const b = x.backupLast;
  if (!x.smtp) add('backup', 'Weekly backup email', 'warn', 'Email is not set up, so no backup is sent', 'Set SMTP_* in Railway, or download a backup from Admin → Data Sources each week.');
  else if (!b) add('backup', 'Weekly backup email', 'warn', 'No backup sent yet', 'It goes out Sundays at 3 AM; or send one now from Admin → Data Sources.');
  else if (!b.sent) add('backup', 'Weekly backup email', 'bad', 'Last backup ' + ago(age(now, b.at)) + ' failed' + (b.error ? ': ' + b.error : ''), 'Download one from Admin → Data Sources now.');
  else add('backup', 'Weekly backup email', age(now, b.at) > 8 * D ? 'bad' : 'good', 'Sent ' + ago(age(now, b.at)) + (b.to ? ' to ' + b.to : '') + (b.mb ? ' · ' + b.mb + ' MB' : ''), 'More than a week old: send one from Admin → Data Sources.');

  // Where alerts go
  const ch = x.alerts || {};
  if (!ch.ntfy && !ch.email) add('alerts', 'Phone / email alerts', 'warn', 'Not set up: problems only show on this page', 'Set NTFY_TOPIC (phone) and/or ALERT_EMAIL_TO in Railway.');
  else add('alerts', 'Phone / email alerts', 'good', [ch.ntfy ? 'Phone (ntfy)' : '', ch.email ? 'Email' : ''].filter(Boolean).join(' + '));

  // Server errors since the last restart (last 24 h)
  const n = x.errors24h || 0;
  add('errors', 'Server errors (24 h)', n >= 10 ? 'bad' : n ? 'warn' : 'good', n ? n + ' request' + (n === 1 ? '' : 's') + ' failed' : 'None', 'See the list below: the newest error says which screen and what went wrong.');

  const worst = out.some(c => c.state === 'bad') ? 'bad' : out.some(c => c.state === 'warn') ? 'warn' : 'good';
  return { overall: worst, checks: out };
}

// Several server errors close together means something is broken, not one
// bad request: alert once, then stay quiet for a while.
function errorBurst(times, now, { within = 15 * 60 * 1000, count = 5 } = {}) {
  return times.filter(t => now - t <= within).length >= count;
}

module.exports = { checks, errorBurst, ago, AUTH_RE };

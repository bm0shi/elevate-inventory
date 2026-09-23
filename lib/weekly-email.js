// ============================================================
// WEEKLY RUN EMAIL — after each Sunday auto-refresh, email the owner what
// ran, what failed, and the P&L headline, so a failed run is noticed on
// Monday instead of weeks later.
//
// Sends through any SMTP server. For Gmail: turn on 2-step verification,
// create an App Password, then set in Railway:
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=465
//   SMTP_USER=<gmail address> SMTP_PASS=<16-char app password>
//   REPORT_EMAIL_TO=<where it goes>   (defaults to SMTP_USER)
// With no SMTP settings it logs and does nothing.
// ============================================================
const nodemailer = require('nodemailer');

function configured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function money(n) {
  if (n == null || isNaN(n)) return '—';
  const v = Math.round(Number(n));
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US');
}

function esc(v) {
  return v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pure: build { subject, text, html } from a finished run. Kept separate from
// sending so it can be tested.
function buildEmail({ ok, steps, weekKey, trigger }, snapshot) {
  const failed = steps.filter(s => !s.ok);
  const months = (snapshot && snapshot.months) || [];
  const cur = months[months.length - 1];
  const when = weekKey ? `week ending ${weekKey}` : `${trigger || 'manual'} run`;
  const subject = ok
    ? `Elevate weekly refresh OK — ${when}${cur && cur.net != null ? ` · ${cur.month} net ${money(cur.net)}` : ''}`
    : `⚠ Elevate weekly refresh: ${failed.length} step(s) FAILED — ${when}`;

  const lines = [];
  lines.push(ok ? 'Every step ran.' : `${failed.length} of ${steps.length} steps failed. The app retries every 3 hours (up to 4 runs).`);
  lines.push('');
  for (const s of steps) lines.push(`${s.ok ? '✓' : '✗'} ${s.name} — ${s.detail}`);
  if (months.length) {
    lines.push('', 'P&L (last 3 months):');
    for (const m of months) {
      lines.push(`  ${m.month}: sales ${money(m.netSales)} · net ${money(m.net)}${m.complete === false ? ' (incomplete)' : ''}`);
    }
  }
  const text = lines.join('\n');

  const rows = steps.map(s => `<tr><td style="padding:4px 10px 4px 0;color:${s.ok ? '#1e8449' : '#c0392b'};font-weight:700">${s.ok ? '✓' : '✗'}</td>`
    + `<td style="padding:4px 10px 4px 0;font-weight:600">${esc(s.name)}</td><td style="padding:4px 0;color:#5a6472">${esc(s.detail)}</td></tr>`).join('');
  const pnl = months.map(m => `<tr><td style="padding:4px 14px 4px 0">${esc(m.month)}</td><td style="padding:4px 14px 4px 0;text-align:right">${money(m.netSales)}</td>`
    + `<td style="padding:4px 14px 4px 0;text-align:right;font-weight:700">${money(m.net)}</td><td style="color:#b7791f">${m.complete === false ? 'incomplete' : ''}</td></tr>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2733">
    <h2 style="margin:0 0 6px;color:${ok ? '#127a7a' : '#c0392b'}">${ok ? 'Weekly refresh OK' : 'Weekly refresh had failures'}</h2>
    <div style="color:#5a6472;margin-bottom:14px">${esc(when)}${ok ? '' : ' · the app retries every 3 hours, up to 4 runs'}</div>
    <table style="border-collapse:collapse">${rows}</table>
    ${months.length ? `<h3 style="margin:18px 0 6px">P&amp;L</h3><table style="border-collapse:collapse"><tr style="color:#5a6472"><td>Month</td><td style="text-align:right;padding-right:14px">Sales</td><td style="text-align:right;padding-right:14px">Net</td><td></td></tr>${pnl}</table>` : ''}
  </div>`;
  return { subject, text, html };
}

async function sendRunEmail(run, pool) {
  if (!configured()) { console.log('[Email] SMTP not configured — weekly summary not sent.'); return { sent: false }; }
  let snapshot = null;
  try {
    const r = await pool.query('SELECT data FROM fin_snapshots ORDER BY id DESC LIMIT 1');
    snapshot = r.rows[0] ? r.rows[0].data : null;
  } catch (e) {}
  const { subject, text, html } = buildEmail(run, snapshot);
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const to = process.env.REPORT_EMAIL_TO || process.env.SMTP_USER;
  await t.sendMail({ from: `"Elevate Inventory" <${process.env.SMTP_USER}>`, to, subject, text, html });
  console.log(`[Email] weekly summary sent to ${to}.`);
  return { sent: true, to };
}

module.exports = { buildEmail, sendRunEmail, configured };

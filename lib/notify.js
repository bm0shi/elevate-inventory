// ============================================================
// PHONE / EMAIL ALERTS (e.g. "Shipment FBA17X checked in after 9 days").
// Two channels, either or both, set in Railway:
//   NTFY_TOPIC      push to the free ntfy app (ntfy.sh): install it on the
//                   phone and subscribe to the same hard-to-guess topic name.
//                   NTFY_SERVER overrides https://ntfy.sh.
//   ALERT_EMAIL_TO  email through the same SMTP settings as the weekly email
//                   (SMTP_HOST/USER/PASS). A carrier's email-to-text address
//                   (e.g. 5551234567@vtext.com) turns it into a text.
// Never throws: an alert that can't be sent is logged, and the stock work
// that triggered it carries on.
// ============================================================
const axios = require('axios');

function channels() {
  return {
    ntfy: !!process.env.NTFY_TOPIC,
    email: !!(process.env.ALERT_EMAIL_TO && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
  };
}

// HTTP headers must be plain ASCII: emoji and curly quotes go in the body.
const asciiHeader = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 200);

async function sendAlert(title, body, { tags } = {}) {
  const ch = channels(), out = { ntfy: null, email: null };
  if (ch.ntfy) {
    try {
      const base = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      await axios.post(`${base}/${encodeURIComponent(process.env.NTFY_TOPIC)}`, String(body || ''),
        { headers: { Title: asciiHeader(title), ...(tags ? { Tags: asciiHeader(tags) } : {}) }, timeout: 15000 });
      out.ntfy = 'sent';
    } catch (e) { out.ntfy = 'failed: ' + e.message; console.error('[Alert] ntfy failed:', e.message); }
  }
  if (ch.email) {
    try {
      const nodemailer = require('nodemailer');
      const port = parseInt(process.env.SMTP_PORT, 10) || 465;
      const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
      await t.sendMail({ from: `"Elevate Inventory" <${process.env.SMTP_USER}>`, to: process.env.ALERT_EMAIL_TO, subject: title, text: body });
      out.email = 'sent';
    } catch (e) { out.email = 'failed: ' + e.message; console.error('[Alert] email failed:', e.message); }
  }
  if (!ch.ntfy && !ch.email) console.log('[Alert] no channel set (NTFY_TOPIC / ALERT_EMAIL_TO):', title);
  return out;
}

// Plain email with attachments (the weekly backup). Throws on failure —
// the caller records it — and returns false when SMTP isn't set up.
async function sendEmail(to, subject, text, attachments) {
  if (!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) || !to) return false;
  const nodemailer = require('nodemailer');
  const port = parseInt(process.env.SMTP_PORT, 10) || 465;
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  await t.sendMail({ from: `"Elevate Inventory" <${process.env.SMTP_USER}>`, to, subject, text, attachments });
  return true;
}

module.exports = { sendAlert, sendEmail, channels, asciiHeader };

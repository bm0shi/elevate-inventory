// ============================================================
// WEEKLY AUTO-REFRESH — every Sunday 11:59 PM Arizona time.
//
// Runs every Amazon-sourced input to the P&L, in order, by calling the same
// endpoints the buttons use, so an automatic run behaves exactly like a manual
// one. Then stores a snapshot of the P&L so each week can be looked back on.
//
// What it CAN'T do (these live outside Amazon): Cosmoprof invoices, Homebase
// timesheets, bank balances. Those stay manual.
//
// Arizona doesn't observe daylight saving, so Phoenix is always UTC-7.
// If the server is down at 11:59 PM Sunday, the run happens as soon as it's
// back up (within the following six days).
// ============================================================
const axios = require('axios');

module.exports = function registerAutorun(app, deps) {
  const { pool, ownerAuth, reconcileInTransit, port } = deps;
  const OWNER = process.env.OWNER_PASSWORD || '';
  const APPPW = process.env.APP_PASSWORD || '';
  const base = `http://127.0.0.1:${port}`;
  const headers = { 'x-owner-password': OWNER, 'x-app-password': APPPW, 'Content-Type': 'application/json' };
  const PHX_OFFSET_MS = 7 * 3600 * 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let running = false, current = null;

  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fin_auto_runs (
        id SERIAL PRIMARY KEY,
        trigger TEXT,
        week_key TEXT,
        started_at TIMESTAMPTZ DEFAULT now(),
        finished_at TIMESTAMPTZ,
        ok BOOLEAN,
        steps JSONB
      );
      CREATE TABLE IF NOT EXISTS fin_snapshots (
        id SERIAL PRIMARY KEY,
        week_key TEXT,
        taken_at TIMESTAMPTZ DEFAULT now(),
        data JSONB
      );
      CREATE TABLE IF NOT EXISTS fin_settings (key TEXT PRIMARY KEY, value TEXT);
    `);
  })().catch(e => console.error('[Auto] schema failed:', e.message));

  // Most recent scheduled moment (Sunday 23:59 Phoenix) at or before now.
  function lastScheduled(now = new Date()) {
    const phx = new Date(now.getTime() - PHX_OFFSET_MS);
    const sun = new Date(Date.UTC(phx.getUTCFullYear(), phx.getUTCMonth(), phx.getUTCDate() - phx.getUTCDay(), 23, 59, 0));
    if (sun > phx) sun.setUTCDate(sun.getUTCDate() - 7);        // Sunday, but before 11:59 PM
    return { key: sun.toISOString().slice(0, 10), utc: new Date(sun.getTime() + PHX_OFFSET_MS) };
  }
  function nextScheduled(now = new Date()) {
    const l = lastScheduled(now);
    return new Date(l.utc.getTime() + 7 * 86400000);
  }

  async function getSetting(k) { try { const r = await pool.query('SELECT value FROM fin_settings WHERE key=$1', [k]); return r.rows[0] ? r.rows[0].value : null; } catch (e) { return null; } }
  async function setSetting(k, v) { await pool.query('INSERT INTO fin_settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]); }

  async function call(method, path, body, timeout = 120000) {
    const r = await axios({ method, url: base + path, headers, data: body || {}, timeout, validateStatus: () => true });
    if (r.status >= 400) throw new Error(`${path} → HTTP ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
    return r.data;
  }
  async function pollUntilDone(path, maxMinutes, isRunning) {
    const until = Date.now() + maxMinutes * 60000;
    while (Date.now() < until) {
      await sleep(15000);
      const s = await call('get', path);
      if (!isRunning(s)) return s;
    }
    throw new Error(`${path} still running after ${maxMinutes} min`);
  }

  async function runAll(trigger, weekKey) {
    if (running) return { already: true };
    running = true;
    const steps = [];
    current = { trigger, started: new Date().toISOString(), steps };
    const idRow = await pool.query('INSERT INTO fin_auto_runs(trigger, week_key, steps) VALUES($1,$2,$3) RETURNING id', [trigger, weekKey, JSON.stringify(steps)]);
    const runId = idRow.rows[0].id;
    const step = async (name, fn) => {
      const s = { name, started: new Date().toISOString(), ok: false, detail: '' };
      steps.push(s);
      try { s.detail = (await fn()) || 'done'; s.ok = true; }
      catch (e) { s.detail = e.message; console.error(`[Auto] ${name} failed:`, e.message); }
      s.finished = new Date().toISOString();
      await pool.query('UPDATE fin_auto_runs SET steps=$2 WHERE id=$1', [runId, JSON.stringify(steps)]).catch(() => {});
    };
    console.log(`[Auto] weekly refresh starting (${trigger}).`);

    await step('Shipment receiving status', async () => {
      const r = await reconcileInTransit();
      return r && r.ok !== false ? `${r.shipments || 0} shipment(s) checked` : (r && r.error) || 'checked';
    });
    await step('FBA inventory', async () => {
      const r = await call('get', '/api/fba-inventory', null, 300000);
      return Array.isArray(r) ? `${r.length} ASIN(s)` : (r && r.items ? `${r.items.length} ASIN(s)` : 'updated');
    });
    await step('Amazon settlements', async () => {
      await call('post', '/api/settlements/sync', { sinceDays: 120, maxReports: 6 });
      const s = await pollUntilDone('/api/settlements/status', 30, x => x.running);
      if (s.error) throw new Error(s.error);
      return `${s.imported || 0} new · ${s.skipped || 0} already on file`;
    });
    await step('Match SKUs to products', async () => {
      const r = await call('post', '/api/settlements/relink');
      return `${r.linked || 0} line(s) newly matched`;
    });
    await step('Shipment freight & placement', async () => {
      await call('post', '/api/shipment-fees/pull', { sinceDays: 120 });
      const s = await pollUntilDone('/api/shipment-fees/status', 20, x => x.running);
      if (s.error) throw new Error(s.error);
      const a = await call('post', '/api/shipment-fees/apply');
      return `${s.plans || 0} plan(s) read · ${a.written || 0} fee(s) filled in`;
    });
    await step('Reblend product costs', async () => {
      const r = await call('post', '/api/costs/recompute');
      return r && r.products != null ? `${r.products} product(s)` : 'done';
    });
    await step('P&L snapshot', async () => {
      const p = await call('get', '/api/finance/pnl?months=3', null, 300000);
      const months = (p.months || []).map(m => ({
        month: m.month, netSales: m.netSales, deposited: m.deposited, paidToBank: m.paidToBank,
        cogs: m.cogs, costCoverage: m.costCoverage, carrier: m.carrier, placement: m.placement,
        royalty: m.royalty, overhead: m.overhead, net: m.net, complete: m.complete }));
      await pool.query('INSERT INTO fin_snapshots(week_key, data) VALUES($1,$2)', [weekKey, JSON.stringify({ months })]);
      const cur = months[months.length - 1];
      return cur ? `${cur.month}: net ${cur.net != null ? '$' + Math.round(cur.net).toLocaleString() : '—'}` : 'saved';
    });

    const ok = steps.every(s => s.ok);
    await pool.query('UPDATE fin_auto_runs SET finished_at=now(), ok=$2, steps=$3 WHERE id=$1', [runId, ok, JSON.stringify(steps)]).catch(() => {});
    if (weekKey) await setSetting('auto_last_week', weekKey).catch(() => {});
    console.log(`[Auto] weekly refresh finished — ${steps.filter(s => s.ok).length}/${steps.length} steps ok.`);
    running = false; current = null;
    return { ok };
  }

  // Check once a minute whether this week's run is due.
  async function tick() {
    try {
      await ready;
      if (running) return;
      if ((await getSetting('auto_enabled')) === 'false') return;
      const l = lastScheduled();
      const last = await getSetting('auto_last_week');
      if (last === null) { await setSetting('auto_last_week', l.key); return; }   // first deploy: start from next Sunday
      if (last === l.key) return;
      if (Date.now() - l.utc.getTime() > 6 * 86400000) { await setSetting('auto_last_week', l.key); return; }
      runAll('scheduled', l.key).catch(e => { running = false; console.error('[Auto] run failed:', e.message); });
    } catch (e) { console.error('[Auto] tick:', e.message); }
  }
  setTimeout(tick, 90 * 1000);            // give the server time to finish booting
  setInterval(tick, 60 * 1000);

  app.get('/api/auto/status', ownerAuth, async (req, res) => {
    try {
      await ready;
      const runs = (await pool.query('SELECT * FROM fin_auto_runs ORDER BY id DESC LIMIT 8')).rows;
      res.json({ running, current, enabled: (await getSetting('auto_enabled')) !== 'false',
                 next: nextScheduled().toISOString(), schedule: 'Sundays 11:59 PM Arizona time', runs });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/auto/run', ownerAuth, async (req, res) => {
    if (running) return res.json({ ok: true, already: true });
    runAll('manual', null).catch(e => { running = false; console.error('[Auto] manual run failed:', e.message); });
    res.json({ ok: true });
  });
  app.post('/api/auto/enabled', ownerAuth, async (req, res) => {
    await setSetting('auto_enabled', req.body && req.body.enabled === false ? 'false' : 'true');
    res.json({ ok: true });
  });
  app.get('/api/auto/snapshots', ownerAuth, async (req, res) => {
    const r = await pool.query('SELECT id, week_key, taken_at, data FROM fin_snapshots ORDER BY id DESC LIMIT 26');
    res.json({ snapshots: r.rows });
  });

  console.log('[Auto] weekly refresh scheduled — Sundays 11:59 PM Arizona time.');
};

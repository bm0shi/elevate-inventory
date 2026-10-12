// ============================================================
// REPRICER — the owner's night price drop, brought in from the separate
// amazon-pricing bot (Admin → Planning → Repricer, owner only).
//
// During each switched-on time slot (Arizona time), every FBA listing with
// stock where someone else holds the Buy Box drops by a flat amount; the
// saved price goes back when the slot ends. Rules in lib/reprice.js.
//
// A SKU is dropped only if ALL pass (same as the old bot):
//   1. >= minStock sellable units at Amazon, and not on the "never" list
//   2. no earlier drop still waiting to go back
//   3. the listing exists, is BUYABLE, has no sale price, and its price reads
//   4. the drop stays above $0 and under the % cap
//   5. we don't already hold the Buy Box (a Buy Box check error = skip)
// The price to put back is saved BEFORE the price changes: no saved row, no
// change. Restores always run, also when the switch is off — switching off
// puts tonight's prices back on the next minute.
//
// Scheduler: every minute. The drop for a slot's night is claimed atomically
// in inv_cache (reprice_drop), so two copies of the server can't both run it.
// A restore that fails is retried with a growing wait and alerts at the 3rd
// failure (lib/notify.js). Mounted from server.js: require('./repricer')(app, deps).
// ============================================================
const R = require('./lib/reprice');

const STOP_BEFORE_END_MIN = 5;     // drops stop this close to the slot's end
const ALERT_AFTER_FAILS = 3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const money = (n) => (n == null ? '?' : '$' + Number(n).toFixed(2));

module.exports = (app, { pool, ownerAuth, spapi, sendAlert, ourSellerId }) => {
  const ready = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_reprice (
        cycle            TEXT NOT NULL,          -- Arizona date the slot started + slot id, e.g. 2026-10-12/s1
        sku              TEXT NOT NULL,
        asin             TEXT,
        units            INTEGER,
        product_type     TEXT,                   -- Amazon needs it to set the price back
        original_price   NUMERIC(10,2),          -- what the restore puts back
        drop_price       NUMERIC(10,2),
        outcome          TEXT NOT NULL,          -- dropped | drop_failed | owned_bb | bb_error | not_buyable | sale_price | no_price | not_found | listing_error | guard_blocked
        restore_status   TEXT,                   -- pending | restored | cleared | left_alone | NULL (never dropped)
        restore_attempts INTEGER NOT NULL DEFAULT 0,
        dropped_at       TIMESTAMPTZ,
        restored_at      TIMESTAMPTZ,
        note             TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (cycle, sku)
      );
      CREATE INDEX IF NOT EXISTS inv_reprice_pending ON inv_reprice (restore_status) WHERE restore_status = 'pending';
    `);
  })();
  ready.catch(e => console.error('[Reprice] table setup failed:', e.message));

  async function getSettings() {
    const r = await pool.query("SELECT data FROM inv_cache WHERE cache_key='reprice_settings'");
    const c = R.checkSettings(r.rows.length ? r.rows[0].data : {});
    return c.ok ? c.settings : R.checkSettings({}).settings;
  }
  async function putCache(key, data) {
    await pool.query('INSERT INTO inv_cache(cache_key, data, updated_at) VALUES($1,$2,now()) ON CONFLICT (cache_key) DO UPDATE SET data=$2, updated_at=now()', [key, JSON.stringify(data)]);
  }
  // The old bot read AMAZON_SELLER_ID(_FM); the app learns ours from offers.
  async function sellerId() {
    const e = process.env;
    return (e.SELLER_ID || e.AMAZON_SELLER_ID_FM || e.AMAZON_SELLER_ID || '').trim() || await ourSellerId();
  }

  // One pricing job at a time in this process; stopReq ends a running drop
  // (switch turned off, "Put prices back now").
  const job = { running: null, cycle: null, progress: '', startedAt: null, stopReq: false, lastError: null };
  let chain = Promise.resolve();
  const alertedAt = {};
  function exclusive(kind, fn) {
    const run = chain.then(async () => {
      job.running = kind; job.startedAt = new Date().toISOString(); job.progress = '';
      try { return await fn(); }
      catch (e) {
        job.lastError = { at: new Date().toISOString(), kind, message: e.message };
        console.error(`[Reprice] ${kind} failed:`, e.message);
        // A restore that can't start is retried every minute: alert once an hour, not every minute.
        if (Date.now() - (alertedAt[kind] || 0) > 3600000) {
          alertedAt[kind] = Date.now();
          sendAlert(kind === 'drop' ? 'Repricer: the price drop did not run' : 'Repricer: prices could not be put back', e.message + '\n\nAdmin → Repricer.', { tags: 'warning' });
        }
      }
      finally { job.running = null; job.cycle = null; job.progress = ''; job.stopReq = false; }
    });
    chain = run.catch(() => {});
    return run;
  }

  // ---------- DROP ----------
  async function record(cycle, base, outcome, extra = {}) {
    // Never overwrites a row still waiting to be restored.
    await pool.query(
      `INSERT INTO inv_reprice (cycle, sku, asin, units, original_price, outcome, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (cycle, sku) DO UPDATE SET
         outcome = CASE WHEN inv_reprice.restore_status = 'pending' THEN inv_reprice.outcome ELSE EXCLUDED.outcome END,
         note = CASE WHEN inv_reprice.restore_status = 'pending' THEN inv_reprice.note ELSE EXCLUDED.note END,
         updated_at = now()`,
      [cycle, base.sku, base.asin || null, base.units ?? null, extra.price ?? null, outcome, extra.note ? String(extra.note).slice(0, 300) : null]
    ).catch(e => console.error('[Reprice] could not record', base.sku, e.message));
  }

  async function runDrop(run) {
    await ready;
    job.cycle = run.cycle;
    const st = await getSettings();
    const sid = await sellerId();
    if (!sid) throw new Error('Our Amazon seller id is not known yet, so no drops tonight. Set SELLER_ID in Railway (Seller Central → Settings → Account Info → Merchant Token).');
    job.progress = 'Reading stock at Amazon…';
    let inv;
    try { inv = await spapi.getFbaInventory(); }
    catch (e) { throw new Error('Could not read FBA stock, so no drops tonight: ' + e.message); }
    const pend = await pool.query("SELECT sku FROM inv_reprice WHERE restore_status='pending'");
    const pendKeys = new Set(pend.rows.map(r => R.skuKey(r.sku)));
    const all = Object.values(inv);
    const items = all.filter(x => (x.fulfillable || 0) >= st.minStock).sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    const counts = { dropped: 0, ownedBB: 0, excluded: 0, stillPending: 0, notBuyable: 0, salePrice: 0, bbErrors: 0, listingErrors: 0, blocked: 0, failed: 0 };
    const failed = [], blocked = [];
    let stopped = null;
    console.log(`[Reprice] drop ${run.cycle}: ${all.length} FBA SKUs, ${items.length} in stock, ${money(st.drop)} off.`);

    for (const [i, item] of items.entries()) {
      job.progress = `Checking ${i + 1} of ${items.length} listings · ${counts.dropped} dropped`;
      // Re-read the switch every SKU: turning it off stops the drop within seconds.
      const cur = await getSettings();
      const still = cur.enabled ? R.activeRun(cur.slots, Date.now()) : null;
      if (job.stopReq || !still || still.cycle !== run.cycle) { stopped = 'switched off'; break; }
      if (run.end - Date.now() < STOP_BEFORE_END_MIN * 60000) { stopped = 'ran into the end of the time slot'; break; }

      const base = { sku: item.sku, asin: item.asin, units: item.fulfillable };
      if (cur.exclude.some(x => R.skuKey(x) === R.skuKey(item.sku))) { counts.excluded++; continue; }
      if (pendKeys.has(R.skuKey(item.sku))) { counts.stillPending++; continue; }

      let L;
      try { L = await spapi.getListingPrice(sid, item.sku); }
      catch (e) { counts.listingErrors++; await record(run.cycle, base, 'listing_error', { note: e.message }); await sleep(250); continue; }
      await sleep(250);
      if (!L.found) { counts.listingErrors++; await record(run.cycle, base, 'not_found'); continue; }
      const asin = L.asin || item.asin;
      if (!L.buyable) { counts.notBuyable++; await record(run.cycle, { ...base, asin }, 'not_buyable', { price: L.price, note: L.statuses.join(',') }); continue; }
      if (L.hasSalePrice) { counts.salePrice++; await record(run.cycle, { ...base, asin }, 'sale_price', { price: L.price }); continue; }
      if (L.price == null) { counts.listingErrors++; await record(run.cycle, { ...base, asin }, 'no_price'); continue; }

      const dp = R.dropPrice(L.price, R.dropFor(asin, cur), cur.maxPct);
      if (dp.blocked) { counts.blocked++; blocked.push(`${item.sku} (${money(L.price)}): ${dp.blocked}`); await record(run.cycle, { ...base, asin }, 'guard_blocked', { price: L.price, note: dp.blocked }); continue; }

      const owned = await spapi.ownsBuyBox(asin, sid);
      await sleep(2100);   // ~0.5/s, under Amazon's offers limit
      if (owned === null) { counts.bbErrors++; await record(run.cycle, { ...base, asin }, 'bb_error', { price: L.price }); continue; }
      if (owned === true) { counts.ownedBB++; await record(run.cycle, { ...base, asin }, 'owned_bb', { price: L.price }); continue; }

      // Save the price to put back FIRST: no saved row, no price change.
      try {
        await pool.query(
          `INSERT INTO inv_reprice (cycle, sku, asin, units, product_type, original_price, drop_price, outcome, restore_status, dropped_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'dropping','pending',now())
           ON CONFLICT (cycle, sku) DO UPDATE SET asin=EXCLUDED.asin, units=EXCLUDED.units, product_type=EXCLUDED.product_type,
             original_price=EXCLUDED.original_price, drop_price=EXCLUDED.drop_price, outcome='dropping', restore_status='pending',
             restore_attempts=0, dropped_at=now(), restored_at=NULL, note=NULL, updated_at=now()`,
          [run.cycle, item.sku, asin, item.fulfillable, L.productType, L.price, dp.price]);
      } catch (e) { counts.failed++; failed.push(`${item.sku}: couldn't save the price to put back, so it was NOT changed (${e.message})`); continue; }

      try {
        await spapi.setListingPrice(sid, item.sku, dp.price, L.productType);
        counts.dropped++;
        console.log(`[Reprice] ${item.sku}: ${money(L.price)} → ${money(dp.price)}`);
        await pool.query("UPDATE inv_reprice SET outcome='dropped', updated_at=now() WHERE cycle=$1 AND sku=$2", [run.cycle, item.sku]).catch(() => {});
      } catch (e) {
        // Stays pending: the restore re-sends the saved price, harmless if the drop never landed.
        counts.failed++; failed.push(`${item.sku}: ${e.message}`);
        await pool.query("UPDATE inv_reprice SET outcome='drop_failed', note=$3, updated_at=now() WHERE cycle=$1 AND sku=$2", [run.cycle, item.sku, e.message.slice(0, 300)]).catch(() => {});
      }
      await sleep(800);
    }

    const out = { cycle: run.cycle, at: new Date().toISOString(), outOfStock: all.length - items.length, ...counts, stopped };
    await putCache('reprice_last', out).catch(() => {});
    console.log('[Reprice] drop done:', JSON.stringify(out));
    if (failed.length || blocked.length || counts.bbErrors + counts.listingErrors >= 10) {
      sendAlert('Repricer: price drop finished with problems', [
        `${counts.dropped} dropped · ${counts.failed} failed · ${counts.blocked} blocked by the safety cap · ${counts.bbErrors + counts.listingErrors} skipped (Amazon errors)`,
        failed.length ? 'Failed:\n• ' + failed.slice(0, 20).join('\n• ') : '',
        blocked.length ? 'Blocked by the safety cap:\n• ' + blocked.slice(0, 20).join('\n• ') : '',
        'Admin → Repricer has the list.',
      ].filter(Boolean).join('\n\n'), { tags: 'warning' });
    }
    return out;
  }

  // ---------- RESTORE (always runs, also when switched off) ----------
  async function runRestore(rows, trigger) {
    await ready;
    if (!rows.length) return { restored: 0, of: 0 };
    const sid = await sellerId();
    if (!sid) throw new Error('Our Amazon seller id is not known, so prices could not be put back. Set SELLER_ID in Railway.');
    const now = Date.now();
    let restored = 0;
    const leftAlone = [], gaveUp = [];
    for (const [i, row] of rows.entries()) {
      job.progress = `Putting prices back: ${i + 1} of ${rows.length}`;
      const orig = Number(row.original_price), drop = Number(row.drop_price);
      const fail = async (msg) => {
        const r = await pool.query("UPDATE inv_reprice SET restore_attempts=restore_attempts+1, note=$3, updated_at=now() WHERE cycle=$1 AND sku=$2 RETURNING restore_attempts",
          [row.cycle, row.sku, String(msg).slice(0, 300)]).catch(() => ({ rows: [] }));
        if (r.rows[0] && r.rows[0].restore_attempts === ALERT_AFTER_FAILS) gaveUp.push(`${row.sku} (should be ${money(orig)}): ${msg}`);
      };
      let live = null, pt = row.product_type;
      const stale = !row.dropped_at || now - new Date(row.dropped_at).getTime() > R.STALE_HOURS * 3600000;
      if (stale || !pt) {
        try { const L = await spapi.getListingPrice(sid, row.sku); live = L.found ? L.price : null; pt = pt || L.productType; }
        catch (e) { await fail(e.message); await sleep(250); continue; }
        await sleep(250);
      }
      const a = R.restoreAction({ ...row, original_price: orig, drop_price: drop }, live, now);
      if (a.act !== 'restore') {
        await pool.query('UPDATE inv_reprice SET restore_status=$3, note=$4, updated_at=now() WHERE cycle=$1 AND sku=$2', [row.cycle, row.sku, a.act, a.note]).catch(() => {});
        if (a.act === 'left_alone') leftAlone.push(`${row.sku}: ${a.note}`);
        continue;
      }
      try {
        await spapi.setListingPrice(sid, row.sku, orig, pt);
        restored++;
        console.log(`[Reprice] ${row.sku}: back to ${money(orig)} (${trigger})`);
        await pool.query("UPDATE inv_reprice SET restore_status='restored', restored_at=now(), note=COALESCE($3, note), updated_at=now() WHERE cycle=$1 AND sku=$2",
          [row.cycle, row.sku, a.note || null]).catch(e => console.warn('[Reprice]', row.sku, 'restored on Amazon but not saved:', e.message));
      } catch (e) {
        // The drop may never have landed: if Amazon already shows the saved price, nothing to fix.
        let now2 = null;
        try { const L = await spapi.getListingPrice(sid, row.sku); now2 = L.found ? L.price : null; } catch (_) {}
        if (R.samePrice(now2, orig)) {
          await pool.query("UPDATE inv_reprice SET restore_status='cleared', note='already at the saved price', updated_at=now() WHERE cycle=$1 AND sku=$2", [row.cycle, row.sku]).catch(() => {});
        } else await fail(e.message);
      }
      await sleep(600);
    }
    if (gaveUp.length) sendAlert('PRICES STILL DROPPED: the repricer could not put them back', `${gaveUp.length} listing(s) failed ${ALERT_AFTER_FAILS} times. The app keeps trying, but fix these in Seller Central now:\n• ${gaveUp.join('\n• ')}`, { tags: 'rotating_light' });
    if (leftAlone.length) sendAlert('Repricer: old drops left alone, please check', `Amazon's price matches neither the saved price nor the drop, so the app did not touch these (someone may have changed them by hand):\n• ${leftAlone.join('\n• ')}`, { tags: 'warning' });
    if (rows.length) console.log(`[Reprice] restore (${trigger}): ${restored} of ${rows.length} put back.`);
    return { restored, of: rows.length };
  }

  // Rows due back: every pending one except the slot that's running now.
  // A failed one waits 2 min × attempts (up to 30) before the next try.
  async function dueRows(activeCycle) {
    await ready;
    const r = await pool.query(
      `SELECT cycle, sku, asin, product_type, original_price, drop_price, dropped_at, restore_attempts
         FROM inv_reprice
        WHERE restore_status = 'pending' AND ($1::text IS NULL OR cycle <> $1)
          AND (restore_attempts = 0 OR updated_at < now() - LEAST(restore_attempts, 15) * interval '2 minutes')
        ORDER BY dropped_at NULLS FIRST`, [activeCycle]);
    return r.rows;
  }

  let ticking = false;
  async function tick() {
    if (ticking || job.running) return;
    ticking = true;
    try {
      await ready;
      const st = await getSettings();
      const now = Date.now();
      const active = st.enabled ? R.activeRun(st.slots, now) : null;
      const due = await dueRows(active ? active.cycle : null);
      if (due.length) await exclusive('restore', () => runRestore(due, 'scheduled'));
      if (active && active.end - Date.now() > STOP_BEFORE_END_MIN * 60000) {
        const claim = await pool.query(
          `INSERT INTO inv_cache(cache_key, data, updated_at) VALUES('reprice_drop', to_jsonb($1::text), now())
           ON CONFLICT (cache_key) DO UPDATE SET data = to_jsonb($1::text), updated_at = now()
           WHERE inv_cache.data IS DISTINCT FROM to_jsonb($1::text) RETURNING 1`, [active.cycle]);
        if (claim.rowCount) exclusive('drop', () => runDrop(active));   // not awaited: the next ticks skip while it runs
      }
    } catch (e) { console.error('[Reprice] tick failed:', e.message); }
    finally { ticking = false; }
  }
  setInterval(tick, 60 * 1000).unref();
  setTimeout(tick, 20 * 1000).unref();   // on boot: put back anything left from before a restart

  // ---------- Routes (owner only: prices are money) ----------
  const runView = (r) => r && { cycle: r.cycle, slot: r.slot.id, label: R.slotName(r.slot), start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() };

  app.get('/api/reprice', ownerAuth, async (req, res) => {
    await ready;
    const st = await getSettings();
    const now = Date.now();
    const active = st.enabled ? R.activeRun(st.slots, now) : null;
    const next = st.enabled ? R.nextRun(st.slots, now) : null;
    const last = await pool.query("SELECT data FROM inv_cache WHERE cache_key='reprice_last'");
    const rows = await pool.query(
      `SELECT r.cycle, r.sku, r.asin, p.name, r.original_price::float AS original, r.drop_price::float AS drop, r.outcome,
              r.restore_status, r.restore_attempts, r.dropped_at, r.restored_at, r.note
         FROM inv_reprice r LEFT JOIN inv_products p ON p.asin = r.asin
        WHERE r.restore_status = 'pending' OR (r.restore_status = 'left_alone' AND r.updated_at > now() - interval '7 days')
           OR r.cycle = (SELECT MAX(cycle) FROM inv_reprice WHERE dropped_at IS NOT NULL)
        ORDER BY r.restore_status = 'pending' DESC, p.name NULLS LAST, r.sku`);
    const hist = await pool.query(
      `SELECT cycle, COUNT(*) FILTER (WHERE dropped_at IS NOT NULL)::int AS dropped,
              COUNT(*) FILTER (WHERE outcome = 'owned_bb')::int AS owned,
              COUNT(*) FILTER (WHERE restore_status IN ('restored','cleared'))::int AS back,
              COUNT(*) FILTER (WHERE restore_status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE restore_status = 'left_alone')::int AS left_alone,
              MIN(dropped_at) AS first_drop
         FROM inv_reprice GROUP BY cycle ORDER BY cycle DESC LIMIT 14`);
    res.json({
      ok: true, settings: st, now: new Date(now).toISOString(),
      active: runView(active), next: runView(next ? { ...next, cycle: null } : null),
      job: { running: job.running, progress: job.progress, startedAt: job.startedAt, lastError: job.lastError },
      last: last.rows.length ? last.rows[0].data : null,
      rows: rows.rows, history: hist.rows,
      sellerKnown: !!(await sellerId().catch(() => null)),
    });
  });

  app.post('/api/reprice/settings', ownerAuth, async (req, res) => {
    await ready;
    const prev = await getSettings();
    const c = R.checkSettings(req.body || {}, prev);
    if (!c.ok) return res.status(400).json({ ok: false, error: c.error });
    await putCache('reprice_settings', c.settings);
    console.log('[Reprice] settings saved:', JSON.stringify({ enabled: c.settings.enabled, drop: c.settings.drop, slots: c.settings.slots }));
    // Off, or the running slot removed: stop the drop now and put prices back on this tick.
    const active = c.settings.enabled ? R.activeRun(c.settings.slots, Date.now()) : null;
    if (job.running === 'drop' && (!active || active.cycle !== job.cycle)) job.stopReq = true;
    setTimeout(tick, 1500);
    res.json({ ok: true, settings: c.settings });
  });

  // Put every lowered price back now, the running slot's too. The slot's
  // drop is already claimed, so it won't drop again tonight.
  app.post('/api/reprice/restore-now', ownerAuth, async (req, res) => {
    await ready;
    if (job.running === 'drop') job.stopReq = true;
    const sql = "SELECT cycle, sku, asin, product_type, original_price, drop_price, dropped_at, restore_attempts FROM inv_reprice WHERE restore_status='pending' ORDER BY dropped_at NULLS FIRST";
    const n = (await pool.query(sql)).rows.length;
    // Read the list again once the stopping drop has finished, so its last SKUs come back too.
    exclusive('restore', async () => runRestore((await pool.query(sql)).rows, 'manual'));
    res.json({ ok: true, count: n });
  });
};

// ============================================================
// ELEVATE INVENTORY — server.js
// Scan receiving + on-hand + FBA deduction, Postgres-backed.
// Deploys on Railway alongside your bot.
// ============================================================
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { getReceivedShipments, getShipmentReceivedItems } = require('./spapi');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- Simple password gate (set APP_PASSWORD in Railway) ----
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';

// ---- Postgres ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false } : false
});

// ---- DB setup: create tables + seed products on first boot ----
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inv_products (
      asin TEXT PRIMARY KEY,
      sku TEXT,
      name TEXT,
      upc TEXT
    );
    CREATE TABLE IF NOT EXISTS inv_stock (
      asin TEXT PRIMARY KEY REFERENCES inv_products(asin),
      onhand INTEGER NOT NULL DEFAULT 0,
      transit INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS inv_activity (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT now(),
      direction TEXT,
      asin TEXT,
      name TEXT,
      qty INTEGER,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_upc ON inv_products(upc);
    CREATE TABLE IF NOT EXISTS inv_processed_shipments (
      shipment_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ DEFAULT now(),
      units_cleared INTEGER DEFAULT 0
    );
    -- Shipments the app created (only these can be auto-cleared)
    CREATE TABLE IF NOT EXISTS inv_shipments (
      shipment_id TEXT PRIMARY KEY,
      shipment_name TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      status TEXT DEFAULT 'in_transit'
    );
    -- Per-shipment line items (what we sent, tagged to a shipment)
    CREATE TABLE IF NOT EXISTS inv_shipment_items (
      id SERIAL PRIMARY KEY,
      shipment_id TEXT REFERENCES inv_shipments(shipment_id),
      asin TEXT,
      qty INTEGER
    );
  `);

  // Seed products once (only if table empty)
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM inv_products');
  if (rows[0].n === 0) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
    for (const p of seed) {
      await pool.query(
        'INSERT INTO inv_products(asin, sku, name, upc) VALUES($1,$2,$3,$4) ON CONFLICT (asin) DO NOTHING',
        [p.asin, p.sku || '', p.name || '', '']
      );
      await pool.query('INSERT INTO inv_stock(asin) VALUES($1) ON CONFLICT (asin) DO NOTHING', [p.asin]);
    }
    console.log(`[Inventory] Seeded ${seed.length} products.`);
  }
  console.log('[Inventory] DB ready.');
}

// ---- Auth middleware (very simple header check) ----
function auth(req, res, next) {
  if (req.headers['x-app-password'] === APP_PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---- API ROUTES ----

// login check
app.post('/api/login', (req, res) => {
  if (req.body.password === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// find product by scanned code (UPC, ASIN, or SKU)
app.get('/api/find/:code', auth, async (req, res) => {
  const code = req.params.code.trim();
  const { rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, s.onhand, s.transit
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     WHERE p.upc = $1 OR UPPER(p.asin) = UPPER($1) OR p.sku = $1 LIMIT 1`, [code]);
  if (rows.length) return res.json({ found: true, product: rows[0] });
  res.json({ found: false });
});

// full product list (for the "which product?" picker + on-hand view)
app.get('/api/products', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, s.onhand, s.transit
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     ORDER BY p.name`);
  res.json(rows);
});

// assign a UPC to a product (learn-as-you-scan)
app.post('/api/assign-upc', auth, async (req, res) => {
  const { asin, upc } = req.body;
  await pool.query('UPDATE inv_products SET upc=$1 WHERE asin=$2', [upc.trim(), asin]);
  res.json({ ok: true });
});

// receive stock in
app.post('/api/receive', auth, async (req, res) => {
  const { asin, qty } = req.body;
  const q = parseInt(qty);
  if (!asin || !q || q < 1) return res.status(400).json({ error: 'bad input' });
  await pool.query('UPDATE inv_stock SET onhand = onhand + $1 WHERE asin=$2', [q, asin]);
  const p = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [asin]);
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty) VALUES($1,$2,$3,$4)',
    ['in', asin, p.rows[0]?.name || '', q]);
  res.json({ ok: true });
});

// ship out (single)
app.post('/api/ship', auth, async (req, res) => {
  const { asin, qty } = req.body;
  const q = parseInt(qty);
  if (!asin || !q || q < 1) return res.status(400).json({ error: 'bad input' });
  await pool.query('UPDATE inv_stock SET onhand = onhand - $1, transit = transit + $1 WHERE asin=$2', [q, asin]);
  const p = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [asin]);
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty) VALUES($1,$2,$3,$4)',
    ['out', asin, p.rows[0]?.name || '', q]);
  res.json({ ok: true });
});

// bulk ship (paste pack slip) — requires a shipment ID; tags units to it
app.post('/api/bulk-ship', auth, async (req, res) => {
  const items = req.body.items || [];
  const shipmentId = (req.body.shipmentId || '').trim();
  const shipmentName = (req.body.shipmentName || '').trim();
  if (!shipmentId) return res.status(400).json({ error: 'Shipment ID required' });

  // Register the shipment (so the sync knows this one belongs to us)
  await pool.query(
    `INSERT INTO inv_shipments(shipment_id, shipment_name) VALUES($1,$2)
     ON CONFLICT (shipment_id) DO UPDATE SET shipment_name = COALESCE(NULLIF($2,''), inv_shipments.shipment_name)`,
    [shipmentId, shipmentName]);

  let done = 0, notfound = [];
  for (const it of items) {
    const code = String(it.code).trim();
    const q = parseInt(it.qty);
    if (!q || q < 1) continue;
    const { rows } = await pool.query(
      `SELECT asin, name FROM inv_products WHERE upc=$1 OR UPPER(asin)=UPPER($1) OR sku=$1 LIMIT 1`, [code]);
    if (rows.length) {
      const asin = rows[0].asin;
      await pool.query('UPDATE inv_stock SET onhand = onhand - $1, transit = transit + $1 WHERE asin=$2', [q, asin]);
      await pool.query('INSERT INTO inv_shipment_items(shipment_id, asin, qty) VALUES($1,$2,$3)', [shipmentId, asin, q]);
      await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
        ['out', asin, rows[0].name, q, 'Shipment ' + shipmentId]);
      done++;
    } else { notfound.push(code); }
  }
  res.json({ ok: true, done, notfound, shipmentId });
});

// List shipments currently in transit (with their items)
app.get('/api/shipments', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.shipment_id, s.shipment_name, s.status, s.created_at,
            COALESCE(SUM(i.qty),0)::int AS units
     FROM inv_shipments s LEFT JOIN inv_shipment_items i ON i.shipment_id = s.shipment_id
     WHERE s.status = 'in_transit'
     GROUP BY s.shipment_id, s.shipment_name, s.status, s.created_at
     ORDER BY s.created_at DESC`);
  res.json(rows);
});

// Manually mark a shipment received (clear its units from transit)
app.post('/api/receive-shipment', auth, async (req, res) => {
  const shipmentId = (req.body.shipmentId || '').trim();
  if (!shipmentId) return res.status(400).json({ error: 'shipmentId required' });
  const items = await pool.query('SELECT asin, qty FROM inv_shipment_items WHERE shipment_id=$1', [shipmentId]);
  let cleared = 0;
  for (const it of items.rows) {
    await pool.query('UPDATE inv_stock SET transit = GREATEST(0, transit - $1) WHERE asin=$2', [it.qty, it.asin]);
    cleared += it.qty;
  }
  await pool.query("UPDATE inv_shipments SET status='received' WHERE shipment_id=$1", [shipmentId]);
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
    ['checkin', '', 'Shipment ' + shipmentId, cleared, 'manually marked received']);
  res.json({ ok: true, cleared });
});

// mark transit as received at FBA (clears transit) — optional housekeeping
app.post('/api/clear-transit', auth, async (req, res) => {
  const { asin, qty } = req.body;
  const q = parseInt(qty);
  await pool.query('UPDATE inv_stock SET transit = GREATEST(0, transit - $1) WHERE asin=$2', [q, asin]);
  res.json({ ok: true });
});

// recent activity
app.get('/api/activity', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM inv_activity ORDER BY ts DESC LIMIT 100');
  res.json(rows);
});

// manual product add
app.post('/api/add-product', auth, async (req, res) => {
  const { asin, name, sku, upc } = req.body;
  if (!asin) return res.status(400).json({ error: 'asin required' });
  await pool.query('INSERT INTO inv_products(asin,name,sku,upc) VALUES($1,$2,$3,$4) ON CONFLICT (asin) DO UPDATE SET name=$2, sku=$3, upc=$4',
    [asin.trim(), name || '', sku || '', upc || '']);
  await pool.query('INSERT INTO inv_stock(asin) VALUES($1) ON CONFLICT (asin) DO NOTHING', [asin.trim()]);
  res.json({ ok: true });
});


// ============================================================
// SP-API AUTO-CLEAR: when Amazon checks in a shipment, clear
// those units from in-transit. Matches by SKU.
// ============================================================
async function reconcileInTransit() {
  console.log('[SP-API] Starting in-transit reconcile...');
  let shipments;
  try {
    // Only look back a short window so we ignore shipments that predate this app.
    // Set RECONCILE_LOOKBACK_DAYS in Railway to control (default 2).
    const lookback = parseInt(process.env.RECONCILE_LOOKBACK_DAYS, 10) || 2;
    shipments = await getReceivedShipments(lookback);
  } catch (err) {
    console.error('[SP-API] reconcile aborted:', err.message);
    return { ok: false, error: err.message };
  }
  console.log(`[SP-API] Found ${shipments.length} received/closed shipments in last 45 days.`);

  let clearedTotal = 0;
  let shipmentsDone = 0;

  for (const s of shipments) {
    const sid = s.ShipmentId;
    // ONLY process shipments the app itself created (matched by ID).
    // This ignores all legacy / externally-created shipments entirely.
    const known = await pool.query("SELECT 1 FROM inv_shipments WHERE shipment_id=$1 AND status='in_transit'", [sid]);
    if (!known.rows.length) continue;

    // skip if already processed
    const seen = await pool.query('SELECT 1 FROM inv_processed_shipments WHERE shipment_id=$1', [sid]);
    if (seen.rows.length) continue;

    // Clear based on what WE recorded for this shipment (not Amazon's per-sku),
    // so it exactly reverses what we added to transit.
    const ourItems = await pool.query('SELECT asin, qty FROM inv_shipment_items WHERE shipment_id=$1', [sid]);
    let clearedThis = 0;
    for (const it of ourItems.rows) {
      await pool.query('UPDATE inv_stock SET transit = GREATEST(0, transit - $1) WHERE asin=$2', [it.qty, it.asin]);
      clearedThis += it.qty;
    }
    await pool.query("UPDATE inv_shipments SET status='received' WHERE shipment_id=$1", [sid]);
    await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
      ['checkin', '', 'Shipment ' + sid, clearedThis, 'Amazon checked in']);
    await pool.query('INSERT INTO inv_processed_shipments(shipment_id, units_cleared) VALUES($1,$2) ON CONFLICT (shipment_id) DO NOTHING', [sid, clearedThis]);
    clearedTotal += clearedThis;
    shipmentsDone++;
    console.log(`[SP-API] Shipment ${sid}: cleared ${clearedThis} units (app-created).`);
  }

  console.log(`[SP-API] Reconcile done. ${shipmentsDone} new shipments, ${clearedTotal} units cleared.`);
  return { ok: true, shipments: shipmentsDone, cleared: clearedTotal };
}

// Manual trigger from the UI
app.post('/api/sync-fba', auth, async (req, res) => {
  const result = await reconcileInTransit();
  res.json(result);
});

// Auto-run every 3 hours
const RECONCILE_INTERVAL_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  reconcileInTransit().catch(e => console.error('[SP-API] scheduled reconcile error:', e.message));
}, RECONCILE_INTERVAL_MS);

// serve the UI
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`[Inventory] Live on port ${PORT}`));
}).catch(err => {
  console.error('[Inventory] DB init failed:', err.message);
  // Start anyway so you can see errors
  app.listen(PORT, () => console.log(`[Inventory] Started (DB error) on port ${PORT}`));
});

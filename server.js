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

// bulk ship (paste pack slip) — accepts array of {code, qty}
app.post('/api/bulk-ship', auth, async (req, res) => {
  const items = req.body.items || [];
  let done = 0, notfound = [];
  for (const it of items) {
    const code = String(it.code).trim();
    const q = parseInt(it.qty);
    if (!q || q < 1) continue;
    const { rows } = await pool.query(
      `SELECT asin, name FROM inv_products WHERE upc=$1 OR UPPER(asin)=UPPER($1) OR sku=$1 LIMIT 1`, [code]);
    if (rows.length) {
      await pool.query('UPDATE inv_stock SET onhand = onhand - $1, transit = transit + $1 WHERE asin=$2', [q, rows[0].asin]);
      await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
        ['out', rows[0].asin, rows[0].name, q, 'bulk pack-slip']);
      done++;
    } else { notfound.push(code); }
  }
  res.json({ ok: true, done, notfound });
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
    shipments = await getReceivedShipments(45);
  } catch (err) {
    console.error('[SP-API] reconcile aborted:', err.message);
    return { ok: false, error: err.message };
  }
  console.log(`[SP-API] Found ${shipments.length} received/closed shipments in last 45 days.`);

  let clearedTotal = 0;
  let shipmentsDone = 0;

  for (const s of shipments) {
    const sid = s.ShipmentId;
    // skip if already processed
    const seen = await pool.query('SELECT 1 FROM inv_processed_shipments WHERE shipment_id=$1', [sid]);
    if (seen.rows.length) continue;

    const items = await getShipmentReceivedItems(sid);
    let clearedThis = 0;

    for (const it of items) {
      if (!it.received || it.received < 1) continue;
      // match SKU -> our product -> clear received qty from transit (floor at 0)
      const p = await pool.query('SELECT asin FROM inv_products WHERE sku=$1 LIMIT 1', [it.sku]);
      if (!p.rows.length) {
        console.log(`[SP-API] SKU ${it.sku} not in our catalog — skipping.`);
        continue;
      }
      const asin = p.rows[0].asin;
      await pool.query('UPDATE inv_stock SET transit = GREATEST(0, transit - $1) WHERE asin=$2', [it.received, asin]);
      await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) SELECT $1,$2,name,$3,$4 FROM inv_products WHERE asin=$2',
        ['checkin', asin, it.received, `FBA check-in ${sid}`]);
      clearedThis += it.received;
    }

    await pool.query('INSERT INTO inv_processed_shipments(shipment_id, units_cleared) VALUES($1,$2) ON CONFLICT (shipment_id) DO NOTHING', [sid, clearedThis]);
    clearedTotal += clearedThis;
    shipmentsDone++;
    console.log(`[SP-API] Shipment ${sid}: cleared ${clearedThis} units from transit.`);
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

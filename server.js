// ============================================================
// ELEVATE INVENTORY — server.js
// Scan receiving + on-hand + FBA deduction, Postgres-backed.
// Deploys on Railway alongside your bot.
// ============================================================
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity, getMyPrices } = require('./spapi');
const keepa = require('./keepa');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Shared: parse Cosmoprof invoice text (multi-order) into created invoices.
async function processInvoiceText(text) {
  const parts = text.split(/FOR ORDER NUMBER:\s*(\d+)/);
  const created = [], errors = [];
  for (let i = 1; i < parts.length; i += 2) {
    const orderNumber = parts[i].trim();
    const body = parts[i+1] || '';
    const dateM = (parts[i-1] + body).match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g);
    const date = dateM ? dateM[dateM.length-1] : '';
    const items = [];
    for (const line of body.split(/\r?\n/)) {
      let m = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+N\s*$/);
      if (m) { items.push({ cosmo_num: m[1], description: m[2].trim(), qty_shipped: parseInt(m[5]), unit_cost: parseFloat(m[4]) }); continue; }
      let m2 = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s*$/);
      if (m2) { items.push({ cosmo_num: m2[1], description: m2[2].trim(), qty_shipped: parseInt(m2[3]), unit_cost: parseFloat(m2[4]), incomplete: true }); }
    }
    if (!items.length) { errors.push(`Order ${orderNumber}: no items parsed`); continue; }
    await pool.query(`INSERT INTO inv_invoices(order_number, invoice_date, status) VALUES($1,$2,'pending') ON CONFLICT (order_number) DO UPDATE SET invoice_date=$2`, [orderNumber, date]);
    await pool.query('DELETE FROM inv_invoice_items WHERE order_number=$1', [orderNumber]);
    let mapped = 0, unmapped = 0;
    for (const it of items) {
      const c6 = (it.cosmo_num.length===7 && it.cosmo_num[0]==='1') ? it.cosmo_num.slice(1) : it.cosmo_num;
      const mm = await pool.query('SELECT asin FROM inv_cosmo_map WHERE cosmo_num=$1 OR cosmo_num=$2', [it.cosmo_num, c6]);
      const asin = mm.rows[0]?.asin || null;
      if (asin) mapped++; else unmapped++;
      await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received, unit_cost) VALUES($1,$2,$3,$4,$5,0,$6)`,
        [orderNumber, it.cosmo_num, it.description, asin, it.qty_shipped, it.unit_cost || null]);
      // update product's latest known cost
      if (asin && it.unit_cost) {
        await pool.query('UPDATE inv_products SET unit_cost=$1 WHERE asin=$2', [it.unit_cost, asin]);
      }
    }
    created.push({ orderNumber, items: items.length, mapped, unmapped, date });
  }
  return { created, errors };
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- Simple password gate (set APP_PASSWORD in Railway) ----
const APP_PASSWORD = process.env.APP_PASSWORD || 'changeme';
// Set AUTH_DISABLED=true in Railway to turn off the password gate (e.g. while testing).
// Remove it or set to false to re-enable. No code change needed.
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';
// Separate password for owner-only data tabs (velocity, profit, inventory value).
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || APP_PASSWORD;

// Normalize a scanned/typed code so 12 vs 13 digit UPC/EAN variants of the SAME
// barcode match. Strips leading zeros for numeric codes; leaves ASIN/SKU alone.
function normCode(raw) {
  if (raw == null) return '';
  let c = String(raw).trim();
  // numeric barcodes: strip leading zeros so 009531136929 == 9531136929 == 0009531136929
  if (/^[0-9]+$/.test(c)) {
    c = c.replace(/^0+/, '');
  }
  return c.toUpperCase();
}

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
      upc TEXT,
      upc_norm TEXT
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
    ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS upc_norm TEXT;
    ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS unit_cost NUMERIC;
    ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS fnsku TEXT;
    CREATE INDEX IF NOT EXISTS idx_fnsku ON inv_products(fnsku);
    -- prepped/staging counts per product (persists across sessions)
    CREATE TABLE IF NOT EXISTS inv_prepped (
      asin TEXT PRIMARY KEY REFERENCES inv_products(asin),
      qty INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE inv_invoice_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC;
    CREATE INDEX IF NOT EXISTS idx_upc ON inv_products(upc);
    CREATE INDEX IF NOT EXISTS idx_upc_norm ON inv_products(upc_norm);
    -- Many UPCs can map to one product (bottle redesigns, multipacks, etc.)
    CREATE TABLE IF NOT EXISTS inv_upcs (
      upc_norm TEXT PRIMARY KEY,
      upc_raw TEXT,
      asin TEXT REFERENCES inv_products(asin)
    );
    CREATE INDEX IF NOT EXISTS idx_upcs_asin ON inv_upcs(asin);
    -- Bundles: a duo/kit ASIN maps to component single ASINs (with qty each)
    CREATE TABLE IF NOT EXISTS inv_bundles (
      bundle_asin TEXT,
      component_asin TEXT,
      qty INTEGER DEFAULT 1,
      PRIMARY KEY (bundle_asin, component_asin)
    );
    -- Cosmoprof item number -> our ASIN
    CREATE TABLE IF NOT EXISTS inv_cosmo_map (
      cosmo_num TEXT PRIMARY KEY,
      asin TEXT
    );
    -- Cache for expensive data pulls (velocity, fba inventory) so they survive page refresh
    CREATE TABLE IF NOT EXISTS inv_cache (
      cache_key TEXT PRIMARY KEY,
      data JSONB,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- Pending/received Cosmoprof invoices
    CREATE TABLE IF NOT EXISTS inv_invoices (
      order_number TEXT PRIMARY KEY,
      invoice_date TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
    -- Invoice line items: expected (from invoice) vs received (scanned)
    CREATE TABLE IF NOT EXISTS inv_invoice_items (
      id SERIAL PRIMARY KEY,
      order_number TEXT REFERENCES inv_invoices(order_number),
      cosmo_num TEXT,
      description TEXT,
      asin TEXT,
      qty_expected INTEGER,
      qty_received INTEGER DEFAULT 0
    );
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
      status TEXT DEFAULT 'in_transit',
      received_at TIMESTAMPTZ,
      has_discrepancy BOOLEAN DEFAULT false
    );
    ALTER TABLE inv_shipment_items ADD COLUMN IF NOT EXISTS qty_received INTEGER;
    ALTER TABLE inv_shipments ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
    ALTER TABLE inv_shipments ADD COLUMN IF NOT EXISTS has_discrepancy BOOLEAN DEFAULT false;
    -- Per-shipment line items (what we sent, tagged to a shipment)
    CREATE TABLE IF NOT EXISTS inv_shipment_items (
      id SERIAL PRIMARY KEY,
      shipment_id TEXT REFERENCES inv_shipments(shipment_id),
      asin TEXT,
      qty INTEGER,
      qty_received INTEGER
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
  // migrate existing single-UPC assignments into the multi-UPC table
  await pool.query(`INSERT INTO inv_upcs(upc_norm, upc_raw, asin)
    SELECT upc_norm, upc, asin FROM inv_products
    WHERE upc_norm IS NOT NULL AND upc_norm <> ''
    ON CONFLICT (upc_norm) DO NOTHING`);
  // seed Cosmoprof# -> ASIN map (only if empty)
  const cm = await pool.query('SELECT COUNT(*)::int AS n FROM inv_cosmo_map');
  if (cm.rows[0].n === 0) {
    try {
      const seedMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'cosmo_map.json'), 'utf8'));
      for (const [cnum, asin] of Object.entries(seedMap)) {
        await pool.query('INSERT INTO inv_cosmo_map(cosmo_num, asin) VALUES($1,$2) ON CONFLICT (cosmo_num) DO NOTHING', [cnum, asin]);
      }
      console.log(`[Inventory] Seeded ${Object.keys(seedMap).length} Cosmoprof mappings.`);
    } catch(e) { console.error('cosmo_map seed skipped:', e.message); }
  }
  // seed FNSKUs from shipment plans (fills blanks only)
  try {
    const seedFn = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_fnskus.json'), 'utf8'));
    let fnCount = 0;
    for (const [asin, fnsku] of Object.entries(seedFn)) {
      const r = await pool.query("UPDATE inv_products SET fnsku=$1 WHERE asin=$2 AND (fnsku IS NULL OR fnsku='')", [fnsku, asin]);
      if (r.rowCount) fnCount++;
    }
    console.log(`[Inventory] Seeded ${fnCount} FNSKUs from shipment plans.`);
  } catch(e) { console.error('fnsku seed skipped:', e.message); }

  // seed unit costs from historical invoices (only fills blanks)
  try {
    const seedCosts = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed_costs.json'), 'utf8'));
    for (const [asin, cost] of Object.entries(seedCosts)) {
      await pool.query('UPDATE inv_products SET unit_cost=$1 WHERE asin=$2 AND unit_cost IS NULL', [cost, asin]);
    }
    console.log(`[Inventory] Seeded costs for ${Object.keys(seedCosts).length} products (blanks only).`);
  } catch(e) { console.error('cost seed skipped:', e.message); }
  console.log('[Inventory] DB ready.');
}

// ---- Auth middleware (very simple header check) ----
function auth(req, res, next) {
  if (AUTH_DISABLED) return next();
  if (req.headers['x-app-password'] === APP_PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}
function ownerAuth(req, res, next) {
  // owner gate removed — treat like regular auth
  if (AUTH_DISABLED) return next();
  if (req.headers['x-app-password'] === APP_PASSWORD) return next();
  if (req.headers['x-owner-password'] === OWNER_PASSWORD) return next();
  return next(); // open for now
}
app.post('/api/owner-login', (req, res) => {
  return res.json({ ok: true }); // owner gate removed
});

// ---- API ROUTES ----

// login check
app.post('/api/login', (req, res) => {
  if (AUTH_DISABLED) return res.json({ ok: true, disabled: true });
  if (req.body.password === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// Tell the UI whether auth is disabled (so it can skip the login screen)
app.get('/api/auth-status', (req, res) => {
  res.json({ disabled: AUTH_DISABLED });
});

// find product by scanned code (UPC, ASIN, or SKU)
app.get('/api/find/:code', auth, async (req, res) => {
  const raw = req.params.code.trim();
  const norm = normCode(raw);
  // 1) check the multi-UPC table (a product can have many barcodes)
  let { rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, s.onhand, s.transit
     FROM inv_upcs u JOIN inv_products p ON p.asin = u.asin
     LEFT JOIN inv_stock s ON s.asin = p.asin
     WHERE u.upc_norm = $1 LIMIT 1`, [norm]);
  if (rows.length) return res.json({ found: true, product: rows[0], scanned: raw });
  // 2) fall back to ASIN / SKU / FNSKU direct match
  ({ rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, p.fnsku, s.onhand, s.transit
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     WHERE UPPER(p.asin) = UPPER($1) OR UPPER(p.sku) = UPPER($1) OR UPPER(p.fnsku) = UPPER($1) LIMIT 1`, [raw]));
  if (rows.length) return res.json({ found: true, product: rows[0], scanned: raw });
  res.json({ found: false, scanned: raw });
});

// full product list (for the "which product?" picker + on-hand view)
app.get('/api/products', auth, async (req, res) => {
  // "prepped" here = units of THIS asin committed to prep, counting:
  //  - direct prepped of this asin (singles), PLUS
  //  - prepped bundles that consume this asin as a component
  const { rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, s.onhand, s.transit,
      (
        COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
        + COALESCE((SELECT SUM(pr.qty * b.qty) FROM inv_prepped pr JOIN inv_bundles b ON b.bundle_asin=pr.asin WHERE b.component_asin=p.asin),0)
      )::int AS prepped
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     ORDER BY p.name`);
  res.json(rows);
});

// assign a UPC to a product (learn-as-you-scan)
app.post('/api/assign-upc', auth, async (req, res) => {
  const { asin, upc } = req.body;
  const raw = (upc||'').trim();
  const norm = normCode(raw);
  // add to the multi-UPC table (a product can have several barcodes)
  await pool.query('INSERT INTO inv_upcs(upc_norm, upc_raw, asin) VALUES($1,$2,$3) ON CONFLICT (upc_norm) DO UPDATE SET asin=$3, upc_raw=$2', [norm, raw, asin]);
  // also keep the primary upc field populated (first/most-recent) for display
  await pool.query('UPDATE inv_products SET upc=COALESCE(NULLIF(upc,\'\'),$1), upc_norm=COALESCE(NULLIF(upc_norm,\'\'),$2) WHERE asin=$3', [raw, norm, asin]);
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

  let done = 0, notfound = [], expandedNote = [];
  for (const it of items) {
    const code = String(it.code).trim();
    const q = parseInt(it.qty);
    if (!q || q < 1) continue;
    const { rows } = await pool.query(
      `SELECT p.asin, p.name FROM inv_products p
       WHERE p.asin IN (SELECT asin FROM inv_upcs WHERE upc_norm=$1)
          OR UPPER(p.asin)=UPPER($2) OR UPPER(p.sku)=UPPER($2)
          OR p.upc_norm=$1 LIMIT 1`, [normCode(code), code]);
    if (rows.length) {
      const matchedAsin = rows[0].asin;
      // expand bundles -> component singles (or itself if not a bundle)
      const parts = await expandToComponents(matchedAsin, q);
      for (const part of parts) {
        await pool.query('UPDATE inv_stock SET onhand = onhand - $1, transit = transit + $1 WHERE asin=$2', [part.qty, part.asin]);
        await pool.query('INSERT INTO inv_shipment_items(shipment_id, asin, qty) VALUES($1,$2,$3)', [shipmentId, part.asin, part.qty]);
        const note = part.fromBundle ? ('Shipment ' + shipmentId + ' (from ' + rows[0].name.slice(0,20) + ' duo)') : ('Shipment ' + shipmentId);
        await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
          ['out', part.asin, part.name, part.qty, note]);
      }
      if (parts.length > 1 || parts[0].fromBundle) expandedNote.push(`${code} → ${parts.length} singles`);
      done++;
    } else { notfound.push(code); }
  }
  // clear prepped staging — shipment is built and shipped
  await clearAllPrepped();
  res.json({ ok: true, done, notfound, shipmentId, expanded: expandedNote });
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

// Delete an invoice (and its line items)
app.post('/api/invoices/:orderNumber/delete', auth, async (req, res) => {
  await pool.query('DELETE FROM inv_invoice_items WHERE order_number=$1', [req.params.orderNumber]);
  await pool.query('DELETE FROM inv_invoices WHERE order_number=$1', [req.params.orderNumber]);
  res.json({ ok: true });
});

// All shipments with their line items (for the Shipments page)
app.get('/api/all-shipments', auth, async (req, res) => {
  const ships = await pool.query(
    `SELECT shipment_id, shipment_name, status, created_at, received_at, has_discrepancy
     FROM inv_shipments ORDER BY created_at DESC LIMIT 200`);
  const items = await pool.query(
    `SELECT si.shipment_id, si.asin, si.qty, si.qty_received, p.name
     FROM inv_shipment_items si JOIN inv_products p ON p.asin = si.asin`);
  const byShip = {};
  for (const it of items.rows) {
    (byShip[it.shipment_id] = byShip[it.shipment_id] || []).push(it);
  }
  const out = ships.rows.map(s => ({ ...s, items: byShip[s.shipment_id] || [] }));
  res.json(out);
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
  await pool.query('INSERT INTO inv_products(asin,name,sku,upc,upc_norm) VALUES($1,$2,$3,$4,$5) ON CONFLICT (asin) DO UPDATE SET name=$2, sku=$3, upc=$4, upc_norm=$5',
    [asin.trim(), name || '', sku || '', upc || '', normCode(upc||'')]);
  await pool.query('INSERT INTO inv_stock(asin) VALUES($1) ON CONFLICT (asin) DO NOTHING', [asin.trim()]);
  if (upc && upc.trim()) {
    await pool.query('INSERT INTO inv_upcs(upc_norm, upc_raw, asin) VALUES($1,$2,$3) ON CONFLICT (upc_norm) DO UPDATE SET asin=$3',
      [normCode(upc), upc.trim(), asin.trim()]);
  }
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

    // Pull Amazon's actual per-SKU received quantities
    const amazonItems = await getShipmentReceivedItems(sid);
    // Map SKU -> received qty from Amazon
    const recvBySku = {};
    for (const ai of amazonItems) { recvBySku[ai.sku] = (recvBySku[ai.sku]||0) + (ai.received||0); }

    // Our recorded items for this shipment
    const ourItems = await pool.query(
      `SELECT si.asin, si.qty, p.sku, p.name FROM inv_shipment_items si
       JOIN inv_products p ON p.asin = si.asin WHERE si.shipment_id=$1`, [sid]);

    let clearedThis = 0;
    let anyDiscrepancy = false;
    for (const it of ourItems.rows) {
      // match Amazon's received by this product's SKU
      const received = recvBySku[it.sku] != null ? recvBySku[it.sku] : it.qty; // fallback: assume all received
      // clear what we sent from transit (transit reflects what left our warehouse)
      await pool.query('UPDATE inv_stock SET transit = GREATEST(0, transit - $1) WHERE asin=$2', [it.qty, it.asin]);
      // record what Amazon received on the line
      await pool.query('UPDATE inv_shipment_items SET qty_received=$1 WHERE shipment_id=$2 AND asin=$3', [received, sid, it.asin]);
      if (received < it.qty) anyDiscrepancy = true;
      clearedThis += it.qty;
    }

    await pool.query("UPDATE inv_shipments SET status='received', received_at=now(), has_discrepancy=$2 WHERE shipment_id=$1", [sid, anyDiscrepancy]);
    await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
      ['checkin', '', 'Shipment ' + sid, clearedThis, anyDiscrepancy ? 'Checked in — DISCREPANCY' : 'Checked in — all received']);
    await pool.query('INSERT INTO inv_processed_shipments(shipment_id, units_cleared) VALUES($1,$2) ON CONFLICT (shipment_id) DO NOTHING', [sid, clearedThis]);
    clearedTotal += clearedThis;
    shipmentsDone++;
    console.log(`[SP-API] Shipment ${sid}: cleared ${clearedThis} units, discrepancy=${anyDiscrepancy}.`);
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

// Given a product ASIN + quantity, expand into actual stock deductions.
// If it's a bundle, return component singles; else return itself.
async function expandToComponents(asin, qty) {
  const comps = await pool.query(
    `SELECT b.component_asin AS asin, b.qty AS per, p.name
     FROM inv_bundles b JOIN inv_products p ON p.asin = b.component_asin
     WHERE b.bundle_asin = $1`, [asin]);
  if (comps.rows.length) {
    return comps.rows.map(c => ({ asin: c.asin, qty: qty * c.per, name: c.name, fromBundle: true }));
  }
  const self = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [asin]);
  return [{ asin, qty, name: self.rows[0]?.name || '', fromBundle: false }];
}

// ---- Bundle management endpoints ----
app.get('/api/bundles', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.bundle_asin, bp.name AS bundle_name, b.component_asin, cp.name AS component_name, b.qty
     FROM inv_bundles b
     JOIN inv_products bp ON bp.asin = b.bundle_asin
     JOIN inv_products cp ON cp.asin = b.component_asin
     ORDER BY bp.name`);
  // group by bundle
  const map = {};
  for (const r of rows) {
    (map[r.bundle_asin] = map[r.bundle_asin] || { bundle_asin: r.bundle_asin, bundle_name: r.bundle_name, components: [] })
      .components.push({ asin: r.component_asin, name: r.component_name, qty: r.qty });
  }
  res.json(Object.values(map));
});

app.post('/api/bundles', auth, async (req, res) => {
  // { bundle_asin, components: [{asin, qty}] }  — replaces existing definition
  const { bundle_asin, components } = req.body;
  if (!bundle_asin || !Array.isArray(components) || !components.length)
    return res.status(400).json({ error: 'bundle_asin and components required' });
  await pool.query('DELETE FROM inv_bundles WHERE bundle_asin=$1', [bundle_asin]);
  for (const c of components) {
    await pool.query('INSERT INTO inv_bundles(bundle_asin, component_asin, qty) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [bundle_asin, c.asin, parseInt(c.qty) || 1]);
  }
  res.json({ ok: true });
});

// Bulk import bundles: lines of "duoAsin, singleAsin1, singleAsin2"
app.post('/api/bundles/bulk', auth, async (req, res) => {
  const lines = (req.body.text || '').split('\n');
  let done = 0, errors = [];
  for (const line of lines) {
    const parts = line.split(/[,\t]+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) { if(line.trim()) errors.push(line.trim() + ' (need 3 ASINs)'); continue; }
    const [dASIN, c1, c2] = parts;
    // verify all three exist
    const check = await pool.query('SELECT asin FROM inv_products WHERE asin IN ($1,$2,$3)', [dASIN, c1, c2]);
    const found = check.rows.map(r => r.asin);
    const missing = [dASIN, c1, c2].filter(a => !found.includes(a));
    if (missing.length) { errors.push(line.trim() + ' — not in catalog: ' + missing.join(', ')); continue; }
    await pool.query('DELETE FROM inv_bundles WHERE bundle_asin=$1', [dASIN]);
    await pool.query('INSERT INTO inv_bundles(bundle_asin, component_asin, qty) VALUES($1,$2,1),($1,$3,1) ON CONFLICT DO NOTHING', [dASIN, c1, c2]);
    done++;
  }
  res.json({ ok: true, done, errors });
});

app.post('/api/bundles/delete', auth, async (req, res) => {
  await pool.query('DELETE FROM inv_bundles WHERE bundle_asin=$1', [req.body.bundle_asin]);
  res.json({ ok: true });
});

// ---- RECONCILE / INVOICES ----

// Parse pasted Cosmoprof invoice text into {orderNumber, date, items[]}
function parseCosmoInvoice(text) {
  // Order number: try "ORDER NUMBER: X" (old) or "OMS Order ID: DXXXX" / "Xstore Order ID" (new)
  let orderNumber = null;
  let m1 = text.match(/ORDER NUMBER:\s*(\d+)/i);
  if (m1) orderNumber = m1[1];
  if (!orderNumber) {
    // new format: OMS Order ID: D 0 7 1 5 6 9 1 2  (spaces between digits)
    let m2 = text.match(/OMS\s*Order\s*ID:\s*([D0-9\s]+)/i);
    if (m2) orderNumber = m2[1].replace(/\s+/g,'').trim();
  }
  if (!orderNumber) {
    let m3 = text.match(/Transaction:\s*(\d+)/i);
    if (m3) orderNumber = 'T' + m3[1];
  }
  const dateMatch = text.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i) || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const date = dateMatch ? dateMatch[1] : '';

  const items = [];
  const lines = text.split(/\r?\n/);

  // FORMAT A (old): "ITEM# DESCRIPTION QTY PRICE QTY EXT N" all on one line
  const reA = /(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+N/;
  // FORMAT B (new): a line "ITEM# QTY $price ..." with description on the previous non-empty line
  const reB = /^\s*(\d{6,7})\s+(\d+)\s+\$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const a = line.match(reA);
    if (a) {
      items.push({ cosmo_num: a[1], description: a[2].trim(), qty_ordered: parseInt(a[3]), qty_shipped: parseInt(a[5]) });
      continue;
    }
    const b = line.match(reB);
    if (b) {
      let cnum = b[1];
      // normalize 7-digit (leading 1) to 6-digit
      if (cnum.length === 7 && cnum[0] === '1') cnum = cnum.slice(1);
      const qty = parseInt(b[2]);
      // description = previous non-empty line that isn't a total/disc line
      let desc = '';
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!t) continue;
        if (/^(item ordered|disc|fp_|shipping|payment|subtotal|total|order deposit|tax|fee)/i.test(t)) continue;
        desc = t; break;
      }
      items.push({ cosmo_num: cnum, description: desc, qty_ordered: qty, qty_shipped: qty });
    }
  }
  // FORMAT C (fallback): copy-paste from PDF scrambles columns into separate
  // groups (all item#s together, all descriptions together, all quantities together).
  // If A and B found nothing, try zipping the groups back together.
  if (items.length === 0) {
    const itemNums = [];
    const descs = [];
    const qtys = [];
    for (const raw of lines) {
      const t = raw.trim();
      if (/^\d{6}$/.test(t)) itemNums.push(t);
      else if (/^\d{7}$/.test(t) && t[0]==='1') itemNums.push(t.slice(1));
      else if (/^[A-Z]/.test(t) && /(PM |PAUL|COLOR|TEA TREE|AWAPUHI|MITCH|LAVENDER)/i.test(t)
               && !/(TOTAL|MEMO|DISCOUNT|SHIPPED|ORDERED|CUSTOMER|BALANCE|PAYMENT|HANDLING)/i.test(t)) {
        descs.push(t);
      }
      else if (/^\d{1,4}$/.test(t)) qtys.push(parseInt(t));
    }
    if (itemNums.length > 0 && itemNums.length === descs.length) {
      // qtys usually contains ordered then shipped (duplicated). Use the first block.
      for (let i = 0; i < itemNums.length; i++) {
        const q = qtys[i] != null ? qtys[i] : 0;
        items.push({ cosmo_num: itemNums[i], description: descs[i], qty_ordered: q, qty_shipped: q });
      }
    }
  }

  return { orderNumber, date, items };
}

// Multi-order: split pasted text by "FOR ORDER NUMBER:" and create each invoice
app.post('/api/invoices/add-multi', auth, async (req, res) => {
  const { created, errors } = await processInvoiceText(req.body.text || '');
  if (!created.length) return res.status(400).json({ error: 'No orders found. Text needs "FOR ORDER NUMBER:" headers.', errors });
  res.json({ ok: true, created, errors });
});

// Upload/paste an invoice -> store as pending
app.post('/api/invoices/add', auth, async (req, res) => {
  const parsed = parseCosmoInvoice(req.body.text || '');
  if (!parsed.orderNumber) return res.status(400).json({ error: 'Could not find order number in invoice' });
  if (!parsed.items.length) return res.status(400).json({ error: 'No line items found' });

  await pool.query(
    `INSERT INTO inv_invoices(order_number, invoice_date, status) VALUES($1,$2,'pending')
     ON CONFLICT (order_number) DO UPDATE SET invoice_date=$2`, [parsed.orderNumber, parsed.date]);
  // clear old items for this invoice, re-add
  await pool.query('DELETE FROM inv_invoice_items WHERE order_number=$1', [parsed.orderNumber]);
  let mapped = 0, unmapped = [];
  for (const it of parsed.items) {
    const c6 = (it.cosmo_num.length===7 && it.cosmo_num[0]==='1') ? it.cosmo_num.slice(1) : it.cosmo_num;
    const m = await pool.query('SELECT asin FROM inv_cosmo_map WHERE cosmo_num=$1 OR cosmo_num=$2', [it.cosmo_num, c6]);
    const asin = m.rows[0]?.asin || null;
    if (asin) mapped++; else unmapped.push(it.cosmo_num + ' (' + it.description + ')');
    await pool.query(
      `INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received)
       VALUES($1,$2,$3,$4,$5,0)`,
      [parsed.orderNumber, it.cosmo_num, it.description, asin, it.qty_shipped]);
  }
  res.json({ ok: true, orderNumber: parsed.orderNumber, items: parsed.items.length, mapped, unmapped });
});

// List invoices (pending + recent)
app.get('/api/invoices', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.order_number, i.invoice_date, i.status,
            COUNT(ii.id)::int AS lines,
            COALESCE(SUM(ii.qty_expected),0)::int AS expected,
            COALESCE(SUM(ii.qty_received),0)::int AS received
     FROM inv_invoices i LEFT JOIN inv_invoice_items ii ON ii.order_number = i.order_number
     GROUP BY i.order_number, i.invoice_date, i.status
     ORDER BY i.created_at DESC LIMIT 100`);
  res.json(rows);
});

// Get one invoice's line items (with mapping + progress)
app.get('/api/invoices/:orderNumber', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ii.cosmo_num, ii.description, ii.asin, p.name, ii.qty_expected, ii.qty_received
     FROM inv_invoice_items ii LEFT JOIN inv_products p ON p.asin = ii.asin
     WHERE ii.order_number=$1 ORDER BY ii.id`, [req.params.orderNumber]);
  res.json(rows);
});

// Scan an item against an open invoice -> increment received for that line
app.post('/api/invoices/:orderNumber/scan', auth, async (req, res) => {
  const order = req.params.orderNumber;
  const code = (req.body.code || '').trim();
  const qty = parseInt(req.body.qty) || 1;
  // resolve scanned code -> asin (via multi-upc, asin, or sku)
  let r = await pool.query('SELECT asin FROM inv_upcs WHERE upc_norm=$1 LIMIT 1', [normCode(code)]);
  let asin = r.rows[0]?.asin;
  if (!asin) {
    r = await pool.query('SELECT asin FROM inv_products WHERE UPPER(asin)=UPPER($1) OR UPPER(sku)=UPPER($1) LIMIT 1', [code]);
    asin = r.rows[0]?.asin;
  }
  if (!asin) return res.json({ ok: false, reason: 'unknown_code', code });
  // find the matching invoice line
  const line = await pool.query('SELECT id, qty_expected, qty_received FROM inv_invoice_items WHERE order_number=$1 AND asin=$2 LIMIT 1', [order, asin]);
  if (!line.rows.length) return res.json({ ok: false, reason: 'not_on_invoice', asin });
  await pool.query('UPDATE inv_invoice_items SET qty_received = qty_received + $1 WHERE id=$2', [qty, line.rows[0].id]);
  const np = await pool.query('SELECT p.name, ii.qty_expected, ii.qty_received FROM inv_invoice_items ii JOIN inv_products p ON p.asin=ii.asin WHERE ii.id=$1', [line.rows[0].id]);
  res.json({ ok: true, asin, line: np.rows[0] });
});

// Set the EXPECTED quantity on a line (fix scrambled parse)
app.post('/api/invoices/:orderNumber/set-expected', auth, async (req, res) => {
  const { asin, cosmo_num, qty_expected } = req.body;
  const q = parseInt(qty_expected) || 0;
  if (asin) {
    await pool.query('UPDATE inv_invoice_items SET qty_expected=$1 WHERE order_number=$2 AND asin=$3', [q, req.params.orderNumber, asin]);
  } else if (cosmo_num) {
    await pool.query('UPDATE inv_invoice_items SET qty_expected=$1 WHERE order_number=$2 AND cosmo_num=$3', [q, req.params.orderNumber, cosmo_num]);
  }
  res.json({ ok: true });
});

// Manually set a received qty on a line (corrections)
app.post('/api/invoices/:orderNumber/set-line', auth, async (req, res) => {
  const { asin, qty_received } = req.body;
  await pool.query('UPDATE inv_invoice_items SET qty_received=$1 WHERE order_number=$2 AND asin=$3',
    [parseInt(qty_received)||0, req.params.orderNumber, asin]);
  res.json({ ok: true });
});

// Assign a Cosmoprof number to a product (for unmapped lines)
app.post('/api/cosmo-map', auth, async (req, res) => {
  const { cosmo_num, asin } = req.body;
  await pool.query('INSERT INTO inv_cosmo_map(cosmo_num, asin) VALUES($1,$2) ON CONFLICT (cosmo_num) DO UPDATE SET asin=$2', [cosmo_num, asin]);
  // backfill any invoice lines using this cosmo_num
  await pool.query('UPDATE inv_invoice_items SET asin=$1 WHERE cosmo_num=$2 AND asin IS NULL', [asin, cosmo_num]);
  res.json({ ok: true });
});

// Bulk import Cosmoprof# -> ASIN mappings (lines of "cosmoNum, ASIN")
app.post('/api/cosmo-map/bulk', auth, async (req, res) => {
  const lines = (req.body.text || '').split('\n');
  let done=0, errors=[];
  for (const line of lines) {
    const parts = line.split(/[,\t]+/).map(x=>x.trim()).filter(Boolean);
    if (parts.length < 2) { if(line.trim()) errors.push(line.trim()); continue; }
    const [cnum, asin] = parts;
    const check = await pool.query('SELECT 1 FROM inv_products WHERE asin=$1', [asin]);
    if (!check.rows.length) { errors.push(line.trim()+' — ASIN not in catalog'); continue; }
    await pool.query('INSERT INTO inv_cosmo_map(cosmo_num, asin) VALUES($1,$2) ON CONFLICT (cosmo_num) DO UPDATE SET asin=$2', [cnum, asin]);
    done++;
  }
  res.json({ ok:true, done, errors });
});

// List current cosmo mappings
app.get('/api/cosmo-map', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.cosmo_num, c.asin, p.name FROM inv_cosmo_map c LEFT JOIN inv_products p ON p.asin=c.asin ORDER BY p.name`);
  res.json(rows);
});

// Complete an invoice -> push RECEIVED quantities into on-hand
app.post('/api/invoices/:orderNumber/complete', auth, async (req, res) => {
  const order = req.params.orderNumber;
  const lines = await pool.query('SELECT asin, description, qty_expected, qty_received FROM inv_invoice_items WHERE order_number=$1', [order]);
  let added = 0, discrepancies = [];
  for (const l of lines.rows) {
    if (!l.asin) continue; // unmapped lines skipped
    if (l.qty_received > 0) {
      await pool.query('UPDATE inv_stock SET onhand = onhand + $1 WHERE asin=$2', [l.qty_received, l.asin]);
      await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) SELECT $1,$2,name,$3,$4 FROM inv_products WHERE asin=$2',
        ['in', l.asin, l.qty_received, 'Received invoice ' + order]);
      added += l.qty_received;
    }
    if (l.qty_received !== l.qty_expected) {
      discrepancies.push({ description: l.description, expected: l.qty_expected, received: l.qty_received });
    }
  }
  await pool.query("UPDATE inv_invoices SET status='received', completed_at=now() WHERE order_number=$1", [order]);
  res.json({ ok: true, added, discrepancies });
});

// Upload an Amazon shipment plan file (TSV) to bulk-import FNSKUs
app.post('/api/import-fnskus', auth, upload.single('file'), async (req, res) => {
  let text;
  if (req.file) text = req.file.buffer.toString('utf-8');
  else if (req.body.text) text = req.body.text;
  else return res.status(400).json({ error: 'No file or text' });

  const lines = text.split(/\r?\n/);
  // find header row with Merchant SKU / ASIN / FNSKU columns
  let hdrIdx = -1, cols = [];
  for (let i=0;i<lines.length;i++){
    if (/Merchant SKU/i.test(lines[i]) && /FNSKU/i.test(lines[i])) { hdrIdx=i; cols=lines[i].split('\t').map(c=>c.trim()); break; }
  }
  if (hdrIdx === -1) return res.status(400).json({ error: 'Could not find FNSKU columns. Is this an Amazon shipment plan file?' });

  const skuIdx = cols.findIndex(c=>/Merchant SKU/i.test(c));
  const asinIdx = cols.findIndex(c=>/ASIN/i.test(c));
  const fnIdx = cols.findIndex(c=>/FNSKU/i.test(c));

  let matched = 0, unmatched = [];
  for (let i=hdrIdx+1;i<lines.length;i++){
    const c = lines[i].split('\t');
    if (c.length <= fnIdx) continue;
    const sku = (c[skuIdx]||'').trim();
    const asin = (c[asinIdx]||'').trim();
    const fnsku = (c[fnIdx]||'').trim();
    if (!fnsku) continue;
    // match by ASIN first, then SKU
    let r = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2 RETURNING asin', [fnsku, asin]);
    if (r.rowCount === 0 && sku) r = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE sku=$2 RETURNING asin', [fnsku, sku]);
    if (r.rowCount > 0) matched++;
    else unmatched.push({ sku, asin, fnsku });
  }
  console.log(`[FNSKU Import] Matched ${matched}, unmatched ${unmatched.length}`);
  res.json({ ok: true, matched, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0,20) });
});

// Sync FNSKUs from FBA inventory — matches by SKU first, then ASIN. Returns a report.
app.post('/api/sync-fnskus', auth, async (req, res) => {
  let fba;
  try { fba = await getFbaInventory(); }
  catch(err){ return res.status(400).json({ error: err.message }); }

  let matched = 0, unmatched = [];
  for (const sku in fba) {
    const f = fba[sku];
    if (!f.fnSku) continue;
    // try match by SKU first
    let r = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE sku=$2 RETURNING asin', [f.fnSku, sku]);
    if (r.rowCount === 0 && f.asin) {
      // then by ASIN
      r = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2 RETURNING asin', [f.fnSku, f.asin]);
    }
    if (r.rowCount > 0) matched++;
    else unmatched.push({ sku, asin: f.asin, fnsku: f.fnSku });
  }
  console.log(`[FNSKU Sync] Matched ${matched}, unmatched ${unmatched.length}`);
  res.json({ ok: true, matched, unmatchedCount: unmatched.length, unmatched: unmatched.slice(0,30) });
});

// How many products have an FNSKU (diagnostic)
app.get('/api/fnsku-status', auth, async (req, res) => {
  const total = await pool.query('SELECT COUNT(*)::int AS n FROM inv_products');
  const withFn = await pool.query("SELECT COUNT(*)::int AS n FROM inv_products WHERE fnsku IS NOT NULL AND fnsku<>''");
  res.json({ total: total.rows[0].n, withFnsku: withFn.rows[0].n });
});

// PDF upload -> extract text -> process (multi-order)
app.post('/api/invoices/upload-pdf', auth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let text;
  try {
    const data = await pdfParse(req.file.buffer);
    text = data.text || '';
  } catch (err) {
    return res.status(400).json({ error: 'Could not read PDF: ' + err.message });
  }
  if (!/FOR ORDER NUMBER:/i.test(text)) {
    return res.status(400).json({ error: 'No "FOR ORDER NUMBER:" found in PDF. It may be a different format — try the paste option.' });
  }
  const { created, errors } = await processInvoiceText(text);
  if (!created.length) return res.status(400).json({ error: 'Found order headers but no line items parsed. Try paste as backup.', errors });
  res.json({ ok: true, created, errors });
});

// ============================================================
// DATA / DASHBOARD ENDPOINTS
// ============================================================

// Dashboard summary — everything at a glance (uses data we already have)
app.get('/api/dashboard', auth, async (req, res) => {
  const stock = await pool.query('SELECT COALESCE(SUM(onhand),0)::int AS onhand, COALESCE(SUM(transit),0)::int AS transit FROM inv_stock');
  // total units committed to prep (component-level: singles + duo components)
  const pendingPrep = await pool.query(`
    SELECT (
      COALESCE((SELECT SUM(pr.qty) FROM inv_prepped pr WHERE pr.asin NOT IN (SELECT bundle_asin FROM inv_bundles)),0)
      + COALESCE((SELECT SUM(pr.qty * b.qty) FROM inv_prepped pr JOIN inv_bundles b ON b.bundle_asin=pr.asin),0)
    )::int AS n`);
  const skus = await pool.query('SELECT COUNT(*)::int AS n FROM inv_products');
  const lowStock = await pool.query('SELECT COUNT(*)::int AS n FROM inv_stock WHERE onhand > 0 AND onhand <= 20');
  const outStock = await pool.query('SELECT COUNT(*)::int AS n FROM inv_stock WHERE onhand <= 0');
  const pendingInv = await pool.query("SELECT COUNT(*)::int AS n FROM inv_invoices WHERE status='pending'");
  const pendingUnits = await pool.query("SELECT COALESCE(SUM(ii.qty_expected),0)::int AS n FROM inv_invoice_items ii JOIN inv_invoices i ON i.order_number=ii.order_number WHERE i.status='pending'");
  const openShip = await pool.query("SELECT COUNT(*)::int AS n FROM inv_shipments WHERE status='in_transit'");
  const todayAct = await pool.query("SELECT COUNT(*)::int AS n FROM inv_activity WHERE (ts AT TIME ZONE 'America/Phoenix')::date = (now() AT TIME ZONE 'America/Phoenix')::date");
  // recent activity
  const recent = await pool.query('SELECT direction, name, qty, ts FROM inv_activity ORDER BY ts DESC LIMIT 8');
  // top on-hand
  const topStock = await pool.query('SELECT p.asin, p.name, s.onhand FROM inv_stock s JOIN inv_products p ON p.asin=s.asin WHERE s.onhand>0 ORDER BY s.onhand DESC LIMIT 10');
  // low stock list
  const lowList = await pool.query('SELECT p.asin, p.name, s.onhand FROM inv_stock s JOIN inv_products p ON p.asin=s.asin WHERE s.onhand>0 AND s.onhand<=20 ORDER BY s.onhand ASC LIMIT 10');
  // Under-stocked ranked by recent sales (from cached velocity + retail price if available)
  let underStocked = [];
  try {
    const velCache = await pool.query("SELECT data FROM inv_cache WHERE cache_key='velocity'");
    const valCache = await pool.query("SELECT data FROM inv_cache WHERE cache_key='inventory_value'");
    const priceByAsin = {};
    if (valCache.rows.length) for (const x of (valCache.rows[0].data||[])) if (x.amazon_price) priceByAsin[x.asin] = x.amazon_price;
    if (velCache.rows.length) {
      const items = velCache.rows[0].data?.items || [];
      // map sku->sold, then join to products for asin/onhand
      const bySku = {}; for (const it of items) bySku[it.sku] = it;
      const prods = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand FROM inv_products p JOIN inv_stock s ON s.asin=p.asin');
      const rows = [];
      for (const p of prods.rows) {
        const v = bySku[p.sku];
        const sold = v ? v.sold : 0;
        if (sold <= 0) continue;              // only items actually selling
        if (p.onhand > 100) continue;          // only low/under stocked (threshold 100)
        const price = priceByAsin[p.asin] || 0;
        const revenue = sold * price;          // recent revenue (sold units × price)
        rows.push({ asin: p.asin, name: p.name, onhand: p.onhand, sold, price, revenue });
      }
      // rank by revenue (falls back to units sold when no price)
      rows.sort((a,b) => (b.revenue - a.revenue) || (b.sold - a.sold));
      underStocked = rows.slice(0, 10);
    }
  } catch(e) {}

  // retail value from the last cached pull (if available)
  let retailValue = null, retailAsOf = null;
  try {
    const rv = await pool.query("SELECT data, updated_at FROM inv_cache WHERE cache_key='inventory_value'");
    if (rv.rows.length) {
      const items = rv.rows[0].data || [];
      retailValue = items.reduce((sum, x) => sum + ((x.amazon_price||0) * (x.onhand||0)), 0);
      retailAsOf = rv.rows[0].updated_at;
    }
  } catch(e) {}
  res.json({
    onhand: stock.rows[0].onhand, transit: stock.rows[0].transit,
    skus: skus.rows[0].n, lowStock: lowStock.rows[0].n, outStock: outStock.rows[0].n,
    pendingInvoices: pendingInv.rows[0].n, pendingUnits: pendingUnits.rows[0].n, pendingPrep: pendingPrep.rows[0].n, openShipments: openShip.rows[0].n, todayActivity: todayAct.rows[0].n,
    recent: recent.rows, topStock: topStock.rows, lowList: lowList.rows, underStocked,
    retailValue, retailAsOf
  });
});

// Receiving history — filterable by date range. Amount received + spent.
app.get('/api/receiving-history', auth, async (req, res) => {
  const from = req.query.from || '2000-01-01';
  const to = req.query.to || '2999-12-31';
  // completed invoices in range
  const invs = await pool.query(
    `SELECT order_number, invoice_date, completed_at,
       (SELECT COALESCE(SUM(qty_received),0)::int FROM inv_invoice_items WHERE order_number=i.order_number) AS units
     FROM inv_invoices i WHERE status='received' AND completed_at::date BETWEEN $1 AND $2
     ORDER BY completed_at DESC`, [from, to]);
  // total units received in range (from activity 'in')
  const totalIn = await pool.query(
    "SELECT COALESCE(SUM(qty),0)::int AS units, COUNT(*)::int AS events FROM inv_activity WHERE direction='in' AND ts::date BETWEEN $1 AND $2", [from, to]);
  res.json({ invoices: invs.rows, totalUnits: totalIn.rows[0].units, events: totalIn.rows[0].events });
});

// Discrepancy tab — FBA (Amazon) shipment discrepancies only
app.get('/api/fba-discrepancies', auth, async (req, res) => {
  const ships = await pool.query(
    `SELECT s.shipment_id, s.shipment_name, s.received_at,
       ii.asin, p.name, ii.qty AS sent, ii.qty_received AS received
     FROM inv_shipments s JOIN inv_shipment_items ii ON ii.shipment_id=s.shipment_id
     JOIN inv_products p ON p.asin=ii.asin
     WHERE s.has_discrepancy=true AND ii.qty_received IS NOT NULL AND ii.qty_received < ii.qty
     ORDER BY s.received_at DESC`);
  res.json(ships.rows);
});

// Generic cache get/set (so loaded data survives page refresh)
app.get('/api/cache/:key', auth, async (req, res) => {
  const r = await pool.query('SELECT data, updated_at FROM inv_cache WHERE cache_key=$1', [req.params.key]);
  if (!r.rows.length) return res.json({ cached: false });
  res.json({ cached: true, data: r.rows[0].data, updated_at: r.rows[0].updated_at });
});
async function saveCache(key, data) {
  await pool.query('INSERT INTO inv_cache(cache_key, data, updated_at) VALUES($1,$2,now()) ON CONFLICT (cache_key) DO UPDATE SET data=$2, updated_at=now()', [key, JSON.stringify(data)]);
}

// ---- OWNER-ONLY endpoints ----

// PRODUCTS TO ADD — SmartScout 12+ unit products, flagged by whether we carry them
app.get('/api/products-to-add', ownerAuth, async (req, res) => {
  let ss;
  try { ss = JSON.parse(fs.readFileSync(path.join(__dirname, 'smartscout_products.json'), 'utf8')); }
  catch(e){ return res.status(400).json({ error: 'smartscout_products.json not found' }); }

  // which ASINs do we carry?
  const ours = await pool.query('SELECT asin FROM inv_products');
  const carried = new Set(ours.rows.map(r=>r.asin));

  // optional: pull cached market data for extra signals (sellers, amazon buy box)
  const mktC = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
  const market = mktC.rows.length ? (mktC.rows[0].data||[]) : [];
  const mByAsin = {}; for (const m of market) mByAsin[m.asin] = m;

  const out = ss.map(p => {
    const m = mByAsin[p.asin] || {};
    return {
      asin: p.asin, title: p.title, brand: p.brand,
      units: p.units, revenue: p.revenue, rank: p.rank,
      carried: carried.has(p.asin),
      sellers: m.offerCount, amazonHasBuyBox: m.amazonHasBuyBox, amazonOOS: m.amazonOOS,
    };
  });
  // default: not-carried first, then by units desc
  out.sort((a,b)=> (a.carried?1:0)-(b.carried?1:0) || b.units - a.units);
  res.json(out);
});



// RESTOCK PRIORITY — combines Keepa market data + velocity + FBA + on-hand
// into a ranked "what to reorder" list.
app.get('/api/restock-priority', ownerAuth, async (req, res) => {
  // pull cached data sets
  const mktC = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
  const velC = await pool.query("SELECT data FROM inv_cache WHERE cache_key='velocity'");
  const fbaC = await pool.query("SELECT data FROM inv_cache WHERE cache_key='fba_inventory'");

  const market = mktC.rows.length ? (mktC.rows[0].data||[]) : [];
  const velItems = velC.rows.length ? (velC.rows[0].data?.items||[]) : [];
  const velDays = velC.rows.length ? (velC.rows[0].data?.days||30) : 30;
  const fba = fbaC.rows.length ? (fbaC.rows[0].data||[]) : [];
  // freshness timestamps
  const freshness = {};
  const mktT = await pool.query("SELECT updated_at FROM inv_cache WHERE cache_key='market_data'");
  const velT = await pool.query("SELECT updated_at FROM inv_cache WHERE cache_key='velocity'");
  const fbaT = await pool.query("SELECT updated_at FROM inv_cache WHERE cache_key='fba_inventory'");
  freshness.market = mktT.rows[0]?.updated_at || null;
  freshness.velocity = velT.rows[0]?.updated_at || null;
  freshness.fba = fbaT.rows[0]?.updated_at || null;
  freshness.velocityCount = velItems.length;
  freshness.fbaCount = fba.length;
  freshness.marketCount = market.length;

  // index by asin
  const mByAsin = {}; for (const m of market) mByAsin[m.asin] = m;
  const fbaByAsin = {}; const fbaBySku = {};
  for (const f of fba) {
    if (f.asin) fbaByAsin[f.asin] = f;
    if (f.sku) fbaBySku[f.sku] = f;
  }

  // velocity is keyed by SKU — map sku->sold, and we need sku->asin from products
  // include prepped-committed quantity per component (singles + duo components)
  const prodsRaw = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand, s.transit FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin');
  // dedupe by ASIN — keep the row with the most on-hand (avoids duplicate-ASIN match misses)
  const _seenAsin = {};
  for (const r of prodsRaw.rows) {
    if (!_seenAsin[r.asin] || (r.onhand||0) > (_seenAsin[r.asin].onhand||0)) _seenAsin[r.asin] = r;
  }
  const prods = { rows: Object.values(_seenAsin) };
  // prepped computed separately (safe — never blocks the core plan)
  const preppedByAsin = {};
  try {
    const pr = await pool.query('SELECT asin, qty FROM inv_prepped WHERE qty > 0');
    for (const r of pr.rows) preppedByAsin[r.asin] = (preppedByAsin[r.asin]||0) + r.qty;
    const bd = await pool.query('SELECT b.component_asin AS asin, SUM(p2.qty * b.qty) AS q FROM inv_prepped p2 JOIN inv_bundles b ON b.bundle_asin=p2.asin GROUP BY b.component_asin');
    for (const r of bd.rows) preppedByAsin[r.asin] = (preppedByAsin[r.asin]||0) + parseInt(r.q);
  } catch(e) { /* prepped optional — never break the plan */ }
  const velBySku = {}; const velByAsin = {};
  for (const v of velItems) {
    if (v.sku) { velBySku[v.sku] = v; velBySku[String(v.sku).trim().toUpperCase()] = v; }
    if (v.asin) velByAsin[v.asin] = v;
  }

  const rows = [];
  for (const p of prods.rows) {
    const m = mByAsin[p.asin] || {};
    const v = velByAsin[p.asin] || velBySku[p.sku] || velBySku[String(p.sku||'').trim().toUpperCase()] || {};
    const f = fbaByAsin[p.asin] || fbaBySku[p.sku] || {};

    const onhand = p.onhand || 0;
    const transit = p.transit || 0;
    const fbaTotal = f.fba_total || 0;
    const fbaFulfillable = f.fba_fulfillable || 0;
    const fbaInbound = f.fba_inbound || 0;

    // ===== DEMAND DRIVER: Keepa market demand (NOT our stockout-suppressed sales) =====
    const ourSoldPerDay = v.perDay || 0;                     // our actual sales (info only — skewed by stockouts)
    const keepaMonthly = m.monthlySold || 0;                 // Keepa "bought past month" = TRUE market demand
    // Amazon buy-box discount: if Amazon holds the buy box, third-party sellers (you) capture less.
    // amazonHasBuyBox is a current snapshot; treat it as ~capturing 50% less when Amazon holds it.
    const amazonFactor = m.amazonHasBuyBox ? 0.5 : 1.0;
    // market demand per day you can realistically capture
    const marketDemandPerDay = (keepaMonthly / 30) * amazonFactor;
    // Use market demand as the primary driver; fall back to our sales only if Keepa has no data
    const demandPerDay = marketDemandPerDay > 0 ? marketDemandPerDay : ourSoldPerDay;

    const effectiveFba = fbaTotal;
    const daysAtFba = demandPerDay > 0 ? Math.round(effectiveFba / demandPerDay) : null;

    // opportunity from Keepa market data
    const salesRank = m.salesRank != null ? m.salesRank : null;
    const amazonOOS = m.amazonOOS;
    const sellers = m.offerCount;

    // ---- RESTOCK SCORE ----
    // Higher = more urgent/valuable to send more to FBA.
    let score = 0;
    // urgency: running low at FBA (using effective/total stock incl. inbound)
    if (daysAtFba != null) {
      if (daysAtFba <= 7) score += 40;
      else if (daysAtFba <= 14) score += 25;
      else if (daysAtFba <= 30) score += 10;
    } else if (effectiveFba === 0 && demandPerDay > 0) {
      score += 45; // market demand exists but nothing at FBA = urgent
    }
    // demand: market wants it
    if (demandPerDay >= 10) score += 20;
    else if (demandPerDay >= 3) score += 10;
    else if (demandPerDay > 0) score += 5;
    // market strength (good sales rank)
    if (salesRank != null) {
      if (salesRank < 5000) score += 15;
      else if (salesRank < 30000) score += 8;
      else if (salesRank < 100000) score += 3;
    }
    // opportunity: Amazon weak
    if (amazonOOS != null && amazonOOS > 20) score += 8;
    // opportunity: low competition
    if (sellers != null && sellers <= 3) score += 6;
    // you have warehouse stock to send (can act now)
    const canSendNow = onhand > 0;
    if (canSendNow) score += 5;

    const prepped = preppedByAsin[p.asin] || 0;
    // Coverage already heading to FBA (units that will be sellable soon)
    const coverage = fbaTotal + transit + prepped;
    const coverageDays = demandPerDay > 0 ? coverage / demandPerDay : null;
    // Suggested send: bring FBA coverage up to a 60-day target, drawing from on-hand.
    // Prepped counts toward coverage (already staged), so we only recommend the ADDITIONAL
    // units needed beyond what's prepped/inbound/in-transit.
    let suggestedSend = null;
    if (demandPerDay > 0) {
      const TARGET_DAYS = 60;
      const target = Math.ceil(demandPerDay * TARGET_DAYS);
      const gap = target - coverage;
      const availableToSend = Math.max(0, onhand - prepped);
      suggestedSend = Math.max(0, Math.min(gap, availableToSend));
    }

    // only include items with some signal (selling OR ranked OR we hold stock)
    if (demandPerDay > 0 || salesRank != null || onhand > 0) {
      rows.push({
        asin: p.asin, name: p.name || m.title, onhand, transit, prepped,
        fbaFulfillable: fbaTotal, fbaInbound,
        soldPerDay: Math.round(demandPerDay*10)/10,   // MARKET demand/day (the driver)
        ourSoldPerDay: Math.round(ourSoldPerDay*10)/10, // our actual (reference)
        keepaMonthly, amazonHasBuyBox: m.amazonHasBuyBox,
        daysAtFba, salesRank, amazonOOS, sellers, score, suggestedSend, canSendNow
      });
    }
  }
  // diagnostics: how many products actually matched velocity & fba
  freshness.matchedVelocity = rows.filter(r=>r.soldPerDay>0).length; // now = market demand>0
  freshness.dedupedProductCount = prods.rows.length;
  // how many velocity SOURCE items have perDay>0 (before any matching)?
  freshness.velSourceWithPerDay = velItems.filter(v=>(v.perDay||0)>0).length;
  // velocity items with perDay>0 whose asin is NOT among matched rows
  const matchedAsins = new Set(rows.filter(r=>r.soldPerDay>0).map(r=>r.asin));
  freshness.velMissedSample = velItems.filter(v=>(v.perDay||0)>0 && !matchedAsins.has(v.asin)).slice(0,8).map(v=>({asin:v.asin,sku:v.sku,perDay:v.perDay}));
  freshness.matchedFba = rows.filter(r=>r.fbaFulfillable>0).length;
  freshness.fbaWithTotal = fba.filter(f=>(f.fba_total||0)>0).length;
  freshness.fbaWithFulfillable = fba.filter(f=>(f.fba_fulfillable||0)>0).length;
  // how many FBA asins are in our catalog at all?
  const catalogAsins = new Set(prods.rows.map(p=>p.asin));
  freshness.fbaAsinsInCatalog = fba.filter(f=>catalogAsins.has(f.asin)).length;
  freshness.fbaWithTotalInCatalog = fba.filter(f=>catalogAsins.has(f.asin) && (f.fba_total||0)>0).length;
  // velocity ASINs in catalog?
  freshness.velAsinsInCatalog = velItems.filter(v=>catalogAsins.has(v.asin)).length;
  // sample velocity ASINs that are NOT in catalog
  freshness.velNotInCatalog = velItems.filter(v=>!catalogAsins.has(v.asin)).slice(0,5).map(v=>({asin:v.asin, sku:v.sku, sold:v.sold}));
  // SAMPLE diagnostics — show actual ASINs/SKUs to find the mismatch
  freshness.sampleProductAsins = prods.rows.slice(0,3).map(p=>({asin:p.asin, sku:p.sku}));
  freshness.sampleFbaAsins = fba.slice(0,5).map(f=>({asin:f.asin, total:f.fba_total, fulfillable:f.fba_fulfillable, inbound:f.fba_inbound}));
  freshness.sampleVelSkus = velItems.slice(0,3).map(v=>({sku:v.sku, asin:v.asin, perDay:v.perDay, sold:v.sold}));
  rows.sort((a,b)=> b.score - a.score);
  await saveCache('restock_priority', rows);
  res.json({ items: rows, velDays, freshness });
});



// Keepa market data — pull for target ASINs, cross-reference with our on-hand
app.get('/api/market-data', ownerAuth, async (req, res) => {
  if (!keepa.keyOk()) return res.status(400).json({ error: 'KEEPA_API_KEY not set in Railway variables' });
  // target ASINs: our catalog (can expand later)
  let asins;
  try { asins = JSON.parse(fs.readFileSync(path.join(__dirname, 'keepa_asins.json'), 'utf8')); }
  catch(e){ asins = []; }
  if (!asins.length) return res.status(400).json({ error: 'No target ASINs configured' });

  let products, tokensLeft;
  try { const r = await keepa.getProducts(asins); products = r.products; tokensLeft = r.tokensLeft; }
  catch(err){ return res.status(400).json({ error: err.message }); }

  // cross-reference with our on-hand
  const onhandRows = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin');
  const byAsin = {}; for (const r of onhandRows.rows) byAsin[r.asin] = r;

  const out = products.map(p => {
    const mine = byAsin[p.asin] || {};
    return {
      asin: p.asin,
      name: mine.name || p.title,
      onhand: mine.onhand || 0,
      salesRank: p.salesRank,
      monthlySold: p.monthlySold,
      buyBoxPrice: p.buyBoxPrice,
      amazonHasBuyBox: p.amazonHasBuyBox,
      amazonOOS: p.amazonOOS,
      offerCount: p.offerCount,
    };
  });
  // dedupe by ASIN
  const seen = new Set();
  const deduped = out.filter(x => { if(seen.has(x.asin)) return false; seen.add(x.asin); return true; });
  // default sort: best sales rank (lowest number = best seller) first
  deduped.sort((a,b)=>{
    const ar = a.salesRank == null ? 1e12 : a.salesRank;
    const br = b.salesRank == null ? 1e12 : b.salesRank;
    return ar - br;
  });
  await saveCache('market_data', deduped);
  res.json({ items: deduped, tokensLeft });
});



// Inventory value (owner) — units on hand × cost, needs cost per item
app.get('/api/inventory-value', ownerAuth, async (req, res) => {
  const rows = await pool.query(
    `SELECT p.asin, p.sku, p.name, s.onhand, s.transit
     FROM inv_products p JOIN inv_stock s ON s.asin=p.asin
     WHERE s.onhand > 0`);
  // always pull current Amazon prices (by ASIN)
  let retail = {};
  const asins = rows.rows.map(r => r.asin).filter(Boolean);
  try { retail = await getMyPrices(asins); } catch(e) { console.error('retail fetch failed:', e.message); }
  const out = rows.rows.map(r => ({ ...r, amazon_price: retail[r.asin] || null }));
  out.sort((a,b)=>((b.amazon_price||0)*b.onhand)-((a.amazon_price||0)*a.onhand));
  await saveCache('inventory_value', out);
  res.json(out);
});

// Manually set/override a product's unit cost (owner)
app.post('/api/set-cost', ownerAuth, async (req, res) => {
  const { asin, cost } = req.body;
  await pool.query('UPDATE inv_products SET unit_cost=$1 WHERE asin=$2', [parseFloat(cost)||null, asin]);
  res.json({ ok: true });
});

// FBA inventory (what Amazon holds) — combined with our warehouse on-hand
app.get('/api/fba-inventory', auth, async (req, res) => {
  let fba;
  try { fba = await getFbaInventory(); }
  catch(err){ return res.status(400).json({ error: err.message }); }
  // join with our warehouse on-hand by ASIN
  const ours = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand, s.transit FROM inv_products p JOIN inv_stock s ON s.asin=p.asin');
  const byAsin = {}; for(const r of ours.rows) byAsin[r.asin]=r;
  const out = [];
  const seen = new Set();
  let fnskusSaved = 0;
  for (const sku in fba) {
    const f = fba[sku];
    const o = byAsin[f.asin] || {};
    seen.add(f.asin);
    // capture FNSKU — match by SKU first, then ASIN
    if (f.fnSku) {
      let ur = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE sku=$2', [f.fnSku, sku]);
      if (ur.rowCount === 0 && f.asin) ur = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2', [f.fnSku, f.asin]);
      if (ur.rowCount > 0) fnskusSaved++;
    }
    out.push({ asin: f.asin, sku: sku, name: o.name || sku, warehouse: o.onhand||0, transit: o.transit||0,
      fba_total: f.total, fba_fulfillable: f.fulfillable, fba_inbound: f.inbound,
      grand_total: (o.onhand||0)+(o.transit||0)+f.total });
  }
  console.log(`[FBA] Captured/updated ${fnskusSaved} FNSKUs.`);
  // add our items not in FBA
  for (const r of ours.rows) {
    if (!seen.has(r.asin)) out.push({ asin:r.asin, name:r.name, warehouse:r.onhand, transit:r.transit, fba_total:0, fba_fulfillable:0, fba_inbound:0, grand_total:r.onhand+r.transit });
  }
  out.sort((a,b)=>b.grand_total-a.grand_total);
  await saveCache('fba_inventory', out);
  res.json(out);
});

// Sales velocity (OWNER only) — units sold per SKU + days of stock left
app.get('/api/velocity', ownerAuth, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  let sales;
  try { sales = await getSalesVelocity(days); }
  catch(err){ return res.status(400).json({ error: err.message }); }
  const ours = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand FROM inv_products p JOIN inv_stock s ON s.asin=p.asin');
  const out = [];
  for (const r of ours.rows) {
    const sold = sales[r.sku] || 0;
    const perDay = sold/days;
    const daysLeft = perDay>0 ? Math.round(r.onhand/perDay) : null;
    out.push({ asin:r.asin, name:r.name, sku:r.sku, sold, perDay: Math.round(perDay*10)/10, onhand:r.onhand, daysLeft });
  }
  out.sort((a,b)=>b.sold-a.sold);
  const result = { days, items: out };
  await saveCache('velocity', result);
  res.json(result);
});

app.get('/api/dashboard-owner', ownerAuth, async (req, res) => {
  // placeholder for owner financial summary (velocity/profit come from SP-API tabs)
  res.json({ ok: true });
});

// ============================================================
// PREPPED & READY (FBA staging)
// ============================================================

// Resolve a scanned code (FNSKU / UPC / ASIN / SKU) to a product
async function resolveCode(code) {
  const raw = String(code).trim();
  const norm = normCode(raw);
  // FNSKU / ASIN / SKU direct
  let r = await pool.query(
    `SELECT asin, sku, name, fnsku FROM inv_products
     WHERE UPPER(fnsku)=UPPER($1) OR UPPER(asin)=UPPER($1) OR UPPER(sku)=UPPER($1) LIMIT 1`, [raw]);
  if (r.rows.length) return r.rows[0];
  // UPC (multi table)
  r = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.fnsku FROM inv_upcs u JOIN inv_products p ON p.asin=u.asin WHERE u.upc_norm=$1 LIMIT 1`, [norm]);
  if (r.rows.length) return r.rows[0];
  return null;
}

// Assign an FNSKU to a product (learn-as-you-scan fallback)
app.post('/api/assign-fnsku', auth, async (req, res) => {
  const { asin, fnsku } = req.body;
  await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2', [(fnsku||'').trim(), asin]);
  res.json({ ok: true });
});

// Scan an item into Prepped. Stores the item AS SCANNED (duo shows as duo, single as single).
// The on-hand warning still checks component availability underneath.
app.post('/api/prep/scan', auth, async (req, res) => {
  const { code, qty } = req.body;
  const q = parseInt(qty);
  if (!code || !q || q < 1) return res.status(400).json({ error: 'code + qty required' });
  const prod = await resolveCode(code);
  if (!prod) return res.json({ ok: false, reason: 'unknown_code', code });

  // components this scan consumes (duo → 2 singles, single → itself) — for the WARNING only
  const parts = await expandToComponents(prod.asin, q);
  const isBundle = parts.length > 1 || (parts[0] && parts[0].fromBundle);

  // warning: check on-hand for each component, accounting for what's already committed to prep
  // (both prepped duos and prepped singles consume the same component stock)
  let warnings = [];
  for (const part of parts) {
    const st = await pool.query('SELECT onhand FROM inv_stock WHERE asin=$1', [part.asin]);
    const onhand = st.rows[0]?.onhand || 0;
    // how much of this component is already committed by existing prepped items?
    const committed = await componentCommitted(part.asin);
    const nm = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [part.asin]);
    if (committed + part.qty > onhand) {
      warnings.push({ name: nm.rows[0]?.name || part.asin, onhand, committed, adding: part.qty });
    }
  }

  // store prepped AS SCANNED (the duo asin, or the single asin)
  await pool.query('INSERT INTO inv_prepped(asin, qty) VALUES($1,$2) ON CONFLICT (asin) DO UPDATE SET qty = inv_prepped.qty + $2, updated_at=now()', [prod.asin, q]);
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
    ['prep', prod.asin, prod.name, q, isBundle ? 'Prepped duo' : 'Prepped']);

  res.json({ ok: true, product: prod, qty: q, isBundle, warnings });
});

// How many units of a component ASIN are committed across all prepped items
// (counts prepped singles of that asin + prepped duos that contain it)
async function componentCommitted(componentAsin) {
  // direct prepped of this asin
  const direct = await pool.query('SELECT COALESCE(qty,0) AS q FROM inv_prepped WHERE asin=$1', [componentAsin]);
  let total = direct.rows[0]?.q || 0;
  // prepped bundles that include this component
  const bundles = await pool.query(
    `SELECT pr.qty * b.qty AS q FROM inv_prepped pr
     JOIN inv_bundles b ON b.bundle_asin = pr.asin
     WHERE b.component_asin = $1`, [componentAsin]);
  for (const r of bundles.rows) total += r.q;
  return total;
}

// Current prepped list — items shown AS SCANNED (duos as duos, singles as singles)
app.get('/api/prep/list', auth, async (req, res) => {
  const rows = await pool.query(
    `SELECT pr.asin, p.name, p.sku, p.fnsku, pr.qty AS prepped, s.onhand
     FROM inv_prepped pr JOIN inv_products p ON p.asin=pr.asin LEFT JOIN inv_stock s ON s.asin=pr.asin
     WHERE pr.qty > 0 ORDER BY p.name`);
  // mark which are bundles
  const out = [];
  for (const r of rows.rows) {
    const b = await pool.query('SELECT 1 FROM inv_bundles WHERE bundle_asin=$1 LIMIT 1', [r.asin]);
    out.push({ ...r, isBundle: b.rows.length>0 });
  }
  const totalPrepped = rows.rows.reduce((sum,x)=>sum+x.prepped,0);
  res.json({ items: out, totalPrepped });
});

// Adjust/remove a prepped line (corrections)
app.post('/api/prep/set', auth, async (req, res) => {
  const { asin, qty } = req.body;
  const q = Math.max(0, parseInt(qty)||0);
  if (q === 0) await pool.query('DELETE FROM inv_prepped WHERE asin=$1', [asin]);
  else await pool.query('INSERT INTO inv_prepped(asin,qty) VALUES($1,$2) ON CONFLICT (asin) DO UPDATE SET qty=$2, updated_at=now()', [asin, q]);
  res.json({ ok: true });
});

// Clear ALL prepped (called after a shipment is finalized)
async function clearAllPrepped() {
  await pool.query('DELETE FROM inv_prepped');
}
app.post('/api/prep/clear', auth, async (req, res) => {
  await clearAllPrepped();
  res.json({ ok: true });
});

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

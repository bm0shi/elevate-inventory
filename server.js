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
// Set AUTH_DISABLED=true in Railway to turn off the password gate (e.g. while testing).
// Remove it or set to false to re-enable. No code change needed.
const AUTH_DISABLED = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

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
  console.log('[Inventory] DB ready.');
}

// ---- Auth middleware (very simple header check) ----
function auth(req, res, next) {
  if (AUTH_DISABLED) return next();
  if (req.headers['x-app-password'] === APP_PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

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
  // 2) fall back to ASIN/SKU direct match
  ({ rows } = await pool.query(
    `SELECT p.asin, p.sku, p.name, p.upc, s.onhand, s.transit
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     WHERE UPPER(p.asin) = UPPER($1) OR UPPER(p.sku) = UPPER($1) LIMIT 1`, [raw]));
  if (rows.length) return res.json({ found: true, product: rows[0], scanned: raw });
  res.json({ found: false, scanned: raw });
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

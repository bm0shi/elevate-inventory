// ============================================================
// ELEVATE INVENTORY — server.js
// Scan receiving + on-hand + FBA deduction, Postgres-backed.
// Deploys on Railway alongside your bot.
// ============================================================
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { listSettlementReports, downloadReportDocument, getHazmatStatus, getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity, getMyPrices, getCatalogImages, getCatalogItems, getLiveOffers } = require('./spapi');
const keepa = require('./keepa');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// PURE parser — text in, orders map out. No database access, so it can be
// reused by the read-only audit endpoint.
// Shared: parse Cosmoprof invoice text (multi-order) into created invoices.
//
// IMPORTANT: Cosmoprof repeats "FOR ORDER NUMBER: xxx" on EVERY page of a
// multi-page invoice, so splitting on that header yields one segment PER PAGE,
// not per order. Each write begins with DELETE ... WHERE order_number, so
// writing per-segment used to wipe the earlier pages — a 2-page invoice kept
// only its last page, silently. We now merge every segment sharing an order
// number BEFORE touching the database.
function parseInvoiceText(text) {
  // Cosmoprof has sent at least three layouts. Accept every header style seen:
  //   "FOR ORDER NUMBER: 261642335"   (printed customer invoice)
  //   "Order Number: 261975620"       (order-confirmation screen capture)
  //   "Order #: 261964502"            (order-entry screen)
  const parts = text.split(/(?:FOR\s+)?ORDER\s*(?:NUMBER|NO\.?|#)\s*:?\s*(\d{6,})/i);
  const created = [], errors = [];

  const orders = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    const orderNumber = parts[i].trim();
    const body = parts[i + 1] || '';
    const dateM = (parts[i - 1] + body).match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g);
    const date = dateM ? dateM[dateM.length - 1] : '';

    if (!orders.has(orderNumber)) orders.set(orderNumber, { date, items: [], pages: 0, rejected: [] });
    const o = orders.get(orderNumber);
    o.pages++;
    if (!o.date && date) o.date = date;

    for (const line of body.split(/\r?\n/)) {
      let m = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+N\s*$/);
      if (m) { o.items.push({ cosmo_num: m[1], description: m[2].trim(), qty_shipped: parseInt(m[5]), unit_cost: parseFloat(m[4]) }); continue; }
      let m2 = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s*$/);
      if (m2) { o.items.push({ cosmo_num: m2[1], description: m2[2].trim(), qty_shipped: parseInt(m2[3]), unit_cost: parseFloat(m2[4]), incomplete: true }); continue; }
      // Looked like an item row but did not parse — surface it, never drop it.
      if (/^\s*\d{6}\s+\S/.test(line)) o.rejected.push(line.trim().slice(0, 90));
    }
  }

  return orders;
}

// Parse + persist.
async function processInvoiceText(text) {
  const orders = parseInvoiceText(text);
  const created = [], errors = [];

  const empties = [];
  for (const [orderNumber, o] of orders) {
    const date = o.date;

    // Same item appearing on two pages (split shipment) becomes ONE line with
    // quantities summed. The merge count is reported back so it is never silent.
    const mergedMap = new Map();
    let mergedCount = 0;
    for (const it of o.items) {
      const prev = mergedMap.get(it.cosmo_num);
      if (prev) { prev.qty_shipped += it.qty_shipped; mergedCount++; }
      else mergedMap.set(it.cosmo_num, Object.assign({}, it));
    }
    const items = [...mergedMap.values()];

    if (!items.length) { empties.push(orderNumber); continue; }
    if (o.rejected.length) {
      errors.push(`Order ${orderNumber}: ${o.rejected.length} line(s) looked like items but did NOT parse — ${o.rejected.join(' | ')}`);
    }

    await pool.query(`INSERT INTO inv_invoices(order_number, invoice_date, status) VALUES($1,$2,'pending') ON CONFLICT (order_number) DO UPDATE SET invoice_date=$2`, [orderNumber, date]);
    await pool.query('DELETE FROM inv_invoice_items WHERE order_number=$1', [orderNumber]);
    let mapped = 0, unmapped = 0;
    for (const it of items) {
      const c6 = (it.cosmo_num.length === 7 && it.cosmo_num[0] === '1') ? it.cosmo_num.slice(1) : it.cosmo_num;
      const mm = await pool.query('SELECT asin FROM inv_cosmo_map WHERE cosmo_num=$1 OR cosmo_num=$2', [it.cosmo_num, c6]);
      const asin = mm.rows[0]?.asin || null;
      if (asin) mapped++; else unmapped++;
      await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received, unit_cost) VALUES($1,$2,$3,$4,$5,0,$6)`,
        [orderNumber, it.cosmo_num, it.description, asin, it.qty_shipped, it.unit_cost || null]);
      // NOTE: deliberately NOT writing inv_products.unit_cost here. A sale
      // invoice would overwrite the regular cost permanently. Cost is recorded
      // as a lot at check-in completion and blended in recomputeCosts().
      if (asin && it.unit_cost) {
        await pool.query('UPDATE inv_products SET unit_cost=$1 WHERE asin=$2 AND unit_cost IS NULL', [it.unit_cost, asin]);
      }
    }
    console.log(`[Invoice] ${orderNumber}: ${items.length} items from ${o.pages} page segment(s), ${mapped} mapped, ${unmapped} unmapped.`);
    created.push({ orderNumber, items: items.length, mapped, unmapped, date,
                   pages: o.pages, merged: mergedCount, rejected: o.rejected.length });
  }
  // Only complain about empty segments if NOTHING parsed — a header with no
  // line items is normal in these screen captures.
  if (empties.length && !created.length) {
    errors.push(`Found order header(s) ${empties.join(', ')} but no line items parsed.`);
  }
  return { created, errors };
}

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for a real req.ip
app.use(express.json({ limit: '2mb' }));

// ============================================================
// PASSWORD GATES
// ------------------------------------------------------------
// Two independent gates:
//
//   APP_PASSWORD   - warehouse floor. Scan, receive, prep, ship.
//   OWNER_PASSWORD - admin/analytics. Margin, velocity, value,
//                    restock plan, market data, MFN scan.
//
// AUTH_DISABLED=true opens the WAREHOUSE gate only. It no longer
// opens the owner gate — business data stays protected even while
// the floor runs password-free. Set OWNER_PASSWORD and it is
// enforced regardless of AUTH_DISABLED.
// ============================================================
const crypto = require('crypto');

const APP_PASSWORD   = process.env.APP_PASSWORD   || '';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const AUTH_DISABLED  = String(process.env.AUTH_DISABLED || '').toLowerCase() === 'true';

if (AUTH_DISABLED) {
  console.warn('[Auth] AUTH_DISABLED=true — warehouse routes are OPEN to anyone with the URL.');
  console.warn('[Auth] Owner/admin routes are still gated by OWNER_PASSWORD.');
} else if (!APP_PASSWORD) {
  console.error('[Auth] APP_PASSWORD not set and AUTH_DISABLED not set — every route will reject.');
}
if (!OWNER_PASSWORD) {
  console.error('[Auth] OWNER_PASSWORD not set — all owner/admin routes will reject. Set it in Railway.');
}

// Constant-time compare. False on empty or length-mismatched input.
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ---- Brute-force brake ----
// Only FAILED attempts count, so the "remember this device" re-check on
// page load never trips the limit for a whole warehouse behind one IP.
const loginHits = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 20;

function loginKey(req) { return req.ip || req.socket.remoteAddress || 'unknown'; }

function loginLimiter(req, res, next) {
  const rec = loginHits.get(loginKey(req));
  if (rec && Date.now() < rec.reset && rec.n >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ ok: false, error: 'too many failed attempts — wait 15 minutes' });
  }
  next();
}

function noteLoginFail(req) {
  const k = loginKey(req), now = Date.now();
  const rec = loginHits.get(k);
  if (!rec || now > rec.reset) loginHits.set(k, { n: 1, reset: now + LOGIN_WINDOW_MS });
  else rec.n++;
}

function clearLoginFails(req) { loginHits.delete(loginKey(req)); }

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

// ============================================================
// PALLET LOCATIONS
// Fixed rack map: A-1..A-20 (duo-compatible) and B-1..B-20 (singles).
// Extend LOC_ROWS to add more rows/positions later.
// ============================================================
const LOC_ROWS = { A: 20, B: 20 };
const LOCATION_SLOTS = [];
for (const row of Object.keys(LOC_ROWS)) {
  for (let i = 1; i <= LOC_ROWS[row]; i++) LOCATION_SLOTS.push(row + '-' + i);
}

// Accepts a1, A1, a-1, "A - 1" -> "A-1". Returns null if outside the rack map.
function normLoc(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const m = s.match(/^([A-Z])-?(\d{1,3})$/);
  if (!m) return null;
  const slot = m[1] + '-' + parseInt(m[2], 10);
  return LOCATION_SLOTS.includes(slot) ? slot : null;
}

// Build location context for a set of ASINs: what they have now, and what to
// suggest if they have nothing. Suggestion rules:
//   1. Already has a location -> keep it (this is the "you already have this
//      item in A-1, put these there too" case).
//   2. Duo component whose partner is already placed -> take the neighbouring
//      slot so shampoo/conditioner sit side by side.
//   3. Otherwise -> first free slot in the right row (A if it is a duo
//      component, B if it is singles-only).
async function buildLocationContext(asins) {
  // On-hand is the RAW warehouse figure — it is never reduced when units are
  // committed to a work order, boxed, or consumed building a duo. Showing it at
  // check-in overstates what is physically free on the pallet, so compute the
  // available figure the same way the rest of the app does, duos included.
  const all = await pool.query(
    `SELECT p.asin, p.name, p.location, COALESCE(s.onhand,0)::int AS onhand,
       (
         COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
       + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
       )::int AS pending_prep,
       (
         COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
       + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=p.asin),0)
       )::int AS prepped,
       COALESCE(s.transit,0)::int AS transit,
       EXISTS(SELECT 1 FROM inv_bundles WHERE component_asin=p.asin) AS is_component
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin`);

  const byAsin = {}, used = new Set();
  for (const r of all.rows) {
    byAsin[r.asin] = r;
    if (r.location) used.add(r.location);
  }

  const pm = await pool.query(
    `SELECT b1.component_asin AS asin, b2.component_asin AS partner
     FROM inv_bundles b1
     JOIN inv_bundles b2 ON b2.bundle_asin = b1.bundle_asin
                        AND b2.component_asin <> b1.component_asin`);
  const partners = {};
  for (const r of pm.rows) (partners[r.asin] = partners[r.asin] || []).push(r.partner);

  const out = {};
  for (const asin of asins) {
    const p = byAsin[asin];
    if (!p) continue;
    const isComp = !!p.is_component;

    const pend = p.pending_prep || 0, prep = p.prepped || 0;
    const avail = Math.max(0, (p.onhand || 0) - pend - prep);

    if (p.location) {
      out[asin] = {
        location: p.location, suggested: p.location,
        onhand: p.onhand, pendingPrep: pend, prepped: prep,
        transit: p.transit || 0, available: avail,
        is_component: isComp,
        // "empty" now means nothing FREE on the pallet, not merely zero on-hand
        status: avail > 0 ? 'existing' : 'existing_empty'
      };
      continue;
    }

    const row = isComp ? 'A' : 'B';
    let sug = null;

    for (const pa of (partners[asin] || [])) {
      const pl = byAsin[pa] && byAsin[pa].location;
      if (!pl) continue;
      const m = pl.match(/^([A-Z])-(\d+)$/);
      if (!m) continue;
      const n = parseInt(m[2], 10);
      for (const cand of [m[1] + '-' + (n + 1), m[1] + '-' + (n - 1)]) {
        if (LOCATION_SLOTS.includes(cand) && !used.has(cand)) { sug = cand; break; }
      }
      if (sug) break;
    }

    if (!sug) sug = LOCATION_SLOTS.find(sl => sl.startsWith(row + '-') && !used.has(sl)) || null;
    if (sug) used.add(sug);

    out[asin] = {
      location: null, suggested: sug,
      onhand: p.onhand, pendingPrep: pend, prepped: prep,
      transit: p.transit || 0, available: avail,
      is_component: isComp, status: 'new'
    };
  }
  return out;
}

// ============================================================
// DESCRIPTION MATCHING
// Cosmoprof invoice descriptions are abbreviated ("AWAPUHI MOIST
// SHAMPOO 10.1"); our product names are full Amazon titles. Score by
// token overlap with prefix matching so abbreviations still hit, and
// weight numbers (sizes) heavily since they disambiguate variants.
// ============================================================
const MATCH_STOPWORDS = new Set(['OZ','FLOZ','FL','ML','THE','AND','BY','FOR','WITH','OF','A','AN','NEW','PACK','CT','EA','SIZE','INC','LLC']);

// Cosmoprof descriptions truncate the product name and glue the size onto it:
//   "PM TEA TREE COLORCARE CONDITIONLITER"   -> CONDITION + LITER
//   "PM TEA TREE HAIR & BODY MOISTUR10.14 OZ" -> MOISTUR + 10.14 OZ
//   "COLOR PROTECT SHAMPOO-33.8OZ-LI"         -> SHAMPOO + 33.8 OZ
// Left glued, the word CONDITIONER never appears as a token — which is exactly
// how a conditioner gets linked to a shampoo. Prise them apart, and translate
// Paul Mitchell's "LITER" into the 33.8 fl oz that Amazon titles actually use,
// so the size can do the job of separating variants.
function normalizeSizeTerms(str) {
  let s = String(str || '').toUpperCase();
  s = s.replace(/LITERS?|LTR/g, ' LITER ');
  s = s.replace(/([A-Z])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([A-Z])/g, '$1 $2');
  s = s.replace(/\bLITER\b/g, ' 33.8 ');
  return s;
}

function matchTokens(str) {
  return normalizeSizeTerms(str)
    .replace(/[^A-Z0-9.]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 1 && !MATCH_STOPWORDS.has(t));
}

// How well does one token list cover another?
function coverage(from, against) {
  if (!from.length || !against.length) return 0;
  let hit = 0;
  for (const ft of from) {
    const isNum = /^[0-9.]+$/.test(ft);
    let best = 0;
    for (const at of against) {
      if (at === ft) { best = isNum ? 1.6 : 1; break; }
      if (!isNum && ft.length >= 3 && (at.startsWith(ft) || ft.startsWith(at))) best = Math.max(best, 0.7);
    }
    hit += best;
  }
  return hit / from.length;
}

// Amazon titles here are "<product name>, <marketing copy>, <size>". The part
// before the first comma is the real product name, and it is what distinguishes
// "Tea Tree Special Shampoo" from "Tea Tree Special COLOR Shampoo".
function productHead(name) {
  const s = String(name || '');
  const head = s.split(',')[0];
  return head.length >= 6 ? head : s;
}

// Score BOTH directions:
//   forward — how much of the invoice description the product explains
//   reverse — how much of the product's own name the description accounts for
// Reverse is what punishes an extra discriminating word like COLOR. Combined
// with an F1 so a candidate must satisfy both to win.
function matchScore(desc, name) {
  const d = matchTokens(desc);
  const n = matchTokens(name);
  const h = matchTokens(productHead(name));
  if (!d.length || !n.length) return 0;
  const fwd = coverage(d, n);
  const rev = coverage(h, d);
  if (fwd <= 0 || rev <= 0) return 0;
  return (2 * fwd * rev) / (fwd + rev);
}

// Best candidate products for an unmapped invoice description.
// ============================================================
// SAFETY CROSS-CHECK
// The UPC -> ASIN assignment is the one step where a human can be wrong and
// nothing downstream disagrees — the resulting Cosmo link inherits the error
// and gets stamped "barcode-verified", which is false confidence rather than
// no confidence. So before accepting an assignment, compare the chosen product
// against the invoice wording on two axes that actually distinguish Paul
// Mitchell SKUs: product TYPE and SIZE.
// ============================================================
const PRODUCT_TYPES = ['CONDITIONER','SHAMPOO','TREATMENT','MOISTURIZER','POMADE','SERUM',
  'HAIRSPRAY','CREAM','WAX','GEL','FOAM','CLAY','PASTE','OIL','MASQUE','DETANGLER',
  'RINSE','LOTION','TONIC','PRIMER','BALM','SPRAY'];

// Known Paul Mitchell / Cosmoprof pack sizes. Restricting to these keeps stray
// numbers ("Pack of 1", "2-in-1") from being read as sizes.
const KNOWN_SIZES = new Set(['1.8','2.5','3','3.4','4.2','5.1','6.7','8.5','9','10.1','10.14','12','16.9','24','32','33.8','64','128']);

function detectTypes(str) {
  const s = ' ' + normalizeSizeTerms(str).replace(/[^A-Z0-9.]+/g, ' ') + ' ';
  const out = new Set();
  for (const t of PRODUCT_TYPES) {
    // Cosmoprof truncates: CONDITIONLITER -> CONDITION, MOISTUR10.14 -> MOISTUR
    for (let len = t.length; len >= Math.min(6, t.length); len--) {
      if (s.includes(' ' + t.slice(0, len))) { out.add(t); break; }
    }
  }
  return out;
}

function detectSizes(str) {
  const s = normalizeSizeTerms(str);
  const out = new Set();
  for (const raw of (s.match(/\d{1,3}(?:\.\d{1,2})?/g) || [])) {
    const norm = String(parseFloat(raw));
    if (KNOWN_SIZES.has(norm) || KNOWN_SIZES.has(raw)) out.add(KNOWN_SIZES.has(norm) ? norm : raw);
  }
  return out;
}

const inter = (a, b) => [...a].some(x => b.has(x));

// Compare an invoice description against a product name. Returns the reasons
// they look incompatible — empty array means nothing objectionable found.
function crossCheck(description, productName) {
  const warnings = [];
  const dT = detectTypes(description), pT = detectTypes(productName);
  if (dT.size && pT.size && !inter(dT, pT)) {
    warnings.push({
      kind: 'type',
      message: `The invoice says ${[...dT].join(' / ')} but this product is a ${[...pT].join(' / ')}.`
    });
  }
  const dS = detectSizes(description), pS = detectSizes(productName);
  if (dS.size && pS.size && !inter(dS, pS)) {
    warnings.push({
      kind: 'size',
      message: `The invoice says ${[...dS].join(' / ')} oz but this product is ${[...pS].join(' / ')} oz. (A "LITER" is 33.8 oz.)`
    });
  }
  return warnings;
}

// Suggest a product for an unmapped invoice description.
//
// Deliberately ALL-OR-NOTHING. Measured against the real catalog, a correct
// match scored 0.68 while a wrong one scored 0.67 — the score cannot separate
// right from wrong in the middle of the range, so any "% match" shown to a
// worker is a guess wearing a lab coat. We therefore return AT MOST ONE
// suggestion, and only when it is both strong in absolute terms and clearly
// ahead of second place. Everything else returns nothing, and the worker is
// told to scan a bottle (definitive) or search by hand (deliberate).
// Thresholds calibrated against the real catalog and real invoice text, not
// picked by feel. Measured: correct matches landed at 0.97/0.97/0.97/0.73/0.71/
// 0.64, while a WRONG match landed at 0.70 and an absent product at 0.43. A
// correct 0.64 sitting below a wrong 0.70 means the middle of the range cannot
// be trusted at all. Above 0.90 the sample was clean, so that is the bar.
// Everything below suggests NOTHING — scanning a bottle is the accurate answer,
// and a blank is far cheaper than a confident wrong guess on the floor.
const SUGGEST_MIN_SCORE = 0.90;
const SUGGEST_MIN_GAP   = 0.10;

function suggestProducts(desc, catalog) {
  const seen = new Set();
  const ranked = catalog
    .map(p => ({ asin: p.asin, name: p.name, sku: p.sku, image: p.image, location: p.location, score: matchScore(desc, p.name) }))
    .filter(x => { if (!x.asin || seen.has(x.asin)) return false; seen.add(x.asin); return true; })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return [];
  const top = ranked[0];
  const second = ranked[1] ? ranked[1].score : 0;

  if (top.score < SUGGEST_MIN_SCORE) return [];
  if (ranked.length > 1 && (top.score - second) < SUGGEST_MIN_GAP) return [];

  // No percentage is returned on purpose — the number implies a precision this
  // method does not have, and a worker will believe it.
  return [{ asin: top.asin, name: top.name, sku: top.sku, image: top.image, location: top.location, strong: true }];
}

// Stamped at build time so the running code can be identified from the log
// and from the UI — 'is my deploy actually live' should never be a guess.
const BUILD_ID = 'rowidx-key-0920-0817';

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
    ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS image TEXT;
    CREATE INDEX IF NOT EXISTS idx_fnsku ON inv_products(fnsku);
    -- prepped/staging counts per product (persists across sessions)
    -- Prep work orders: what the owner wants prepped (worker's to-do list)
    CREATE TABLE IF NOT EXISTS inv_pending_prep (
      id SERIAL PRIMARY KEY,
      asin TEXT NOT NULL,          -- the item as requested (duo asin if duo, else the single)
      qty INTEGER NOT NULL,        -- units requested (duos = number of duos)
      is_duo BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    ALTER TABLE inv_pending_prep ADD COLUMN IF NOT EXISTS claimed_by TEXT;
    -- completed prep jobs with timing (productivity metrics)
    CREATE TABLE IF NOT EXISTS inv_prep_log (
      id SERIAL PRIMARY KEY,
      asin TEXT,
      name TEXT,
      qty INTEGER,
      is_duo BOOLEAN DEFAULT false,
      units INTEGER,             -- actual units handled (duos = qty*2)
      worker TEXT,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ DEFAULT now(),
      duration_sec INTEGER
    );
    ALTER TABLE inv_pending_prep ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
    ALTER TABLE inv_pending_prep ADD COLUMN IF NOT EXISTS in_plan BOOLEAN DEFAULT false;
    ALTER TABLE inv_pending_prep ADD COLUMN IF NOT EXISTS in_plan_at TIMESTAMPTZ;
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
  // ---- Pallet location column (idempotent) ----
  try {
    await pool.query('ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS location TEXT');
    console.log('[Inventory] Location column ready.');
  } catch(e) { console.error('location migration skipped:', e.message); }

  // ---- Cost history (idempotent) ----
  // One row per ASIN per invoice — a purchase LOT. Previously the importer did
  // UPDATE inv_products SET unit_cost, so a twice-yearly sale permanently
  // overwrote the regular cost. Lots preserve what was actually paid, when,
  // and how many, which is the only way to get a true blended cost.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_cost_history (
        id SERIAL PRIMARY KEY,
        asin TEXT NOT NULL,
        order_number TEXT NOT NULL,
        invoice_date TEXT,
        unit_cost NUMERIC NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (order_number, asin)
      );
      CREATE INDEX IF NOT EXISTS idx_cost_hist_asin ON inv_cost_history(asin);
      ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS avg_cost NUMERIC;
      ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS regular_cost NUMERIC;
    `);
    console.log('[Inventory] Cost history ready.');
  } catch(e) { console.error('cost history migration skipped:', e.message); }

  // ---- Per-shipment inbound costs (idempotent) ----
  // Amazon shows freight and placement fees when you BUILD a shipment, then
  // charges them again weeks later in the settlement. Both are the same money.
  // One row per (shipment, fee kind) with a source ranking prevents a double
  // count: 'actual' from the settlement always supersedes a manual 'estimate'.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_shipment_costs (
        id SERIAL PRIMARY KEY,
        shipment_id TEXT NOT NULL,
        kind TEXT NOT NULL,                -- freight | placement | prep | other
        amount NUMERIC NOT NULL,
        source TEXT NOT NULL DEFAULT 'estimate',   -- estimate | actual
        settlement_id TEXT,
        note TEXT,
        updated_at TIMESTAMPTZ DEFAULT now(),
        entered_amount NUMERIC,        -- what the owner typed, kept for comparison
        variance NUMERIC,              -- settled minus entered, when they disagree
        UNIQUE (shipment_id, kind)
      );
      ALTER TABLE inv_shipment_costs ADD COLUMN IF NOT EXISTS entered_amount NUMERIC;
      ALTER TABLE inv_shipment_costs ADD COLUMN IF NOT EXISTS variance NUMERIC;
      CREATE INDEX IF NOT EXISTS idx_shipcost_ship ON inv_shipment_costs(shipment_id);
      -- Inbound fees found in settlements that we could not tie to a shipment yet
      CREATE TABLE IF NOT EXISTS inv_unlinked_fees (
        id SERIAL PRIMARY KEY,
        settlement_id TEXT,
        posted_date DATE,
        description TEXT,
        amount NUMERIC,
        raw_shipment_id TEXT,
        linked_shipment_id TEXT,
        UNIQUE (settlement_id, description, amount, posted_date)
      );
    `);
    console.log('[Inventory] Shipment cost tables ready.');
  } catch(e) { console.error('shipment cost migration skipped:', e.message); }

  // ---- Settlement lines (idempotent) ----
  // One row per money movement Amazon reported: principal, each named fee,
  // refunds, refund commissions, adjustments. This is the real deposit, not an
  // estimate, and it is what true net profit has to be built on.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_settlement_lines (
        id SERIAL PRIMARY KEY,
        settlement_id TEXT,
        posted_date DATE,
        transaction_type TEXT,
        order_id TEXT,
        sku TEXT,
        asin TEXT,
        amount_type TEXT,
        amount_description TEXT,
        amount NUMERIC,
        quantity INTEGER,
        deposit_date DATE,
        UNIQUE (settlement_id, order_id, sku, amount_type, amount_description, amount, posted_date)
      );
      CREATE INDEX IF NOT EXISTS idx_settle_sku  ON inv_settlement_lines(sku);
      CREATE INDEX IF NOT EXISTS idx_settle_date ON inv_settlement_lines(posted_date);
      CREATE TABLE IF NOT EXISTS inv_settlements (
        settlement_id TEXT PRIMARY KEY,
        start_date DATE, end_date DATE, deposit_date DATE,
        total_amount NUMERIC, lines INTEGER, imported_at TIMESTAMPTZ DEFAULT now()
      );
      ALTER TABLE inv_settlements ADD COLUMN IF NOT EXISTS report_id TEXT;
      CREATE TABLE IF NOT EXISTS inv_settlement_reports (
        report_id TEXT PRIMARY KEY,
        settlement_id TEXT,
        status TEXT,
        seen_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // The original unique key was (settlement_id, order_id, sku, amount_type,
    // amount_description, amount, posted_date). In the wide flat file dozens of
    // separate sales share all of those — same SKU, same price, same day — so
    // ON CONFLICT DO NOTHING discarded them as duplicates. The row's position in
    // the source file is the only honest identity, and it is stable across
    // re-imports because the same file always parses in the same order.
    await pool.query('ALTER TABLE inv_settlement_lines ADD COLUMN IF NOT EXISTS row_idx INT');
    await pool.query(`DO $$
      DECLARE c RECORD;
      BEGIN
        FOR c IN SELECT conname FROM pg_constraint
                 WHERE conrelid = 'inv_settlement_lines'::regclass AND contype = 'u'
                   AND conname <> 'inv_settlement_lines_settlement_row'
        LOOP EXECUTE 'ALTER TABLE inv_settlement_lines DROP CONSTRAINT ' || quote_ident(c.conname); END LOOP;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_settlement_lines_settlement_row') THEN
          BEGIN
            ALTER TABLE inv_settlement_lines
              ADD CONSTRAINT inv_settlement_lines_settlement_row UNIQUE (settlement_id, row_idx);
          EXCEPTION WHEN others THEN NULL;
          END;
        END IF;
      END $$;`);
    console.log('[Inventory] Settlement tables ready.');
  } catch(e) { console.error('settlement migration skipped:', e.message); }

  // ---- Preppers on a job (idempotent) ----
  // One row per person per job, each with their own join/leave time. That is
  // what lets two or three work the same SKU, someone join late, and someone
  // leave early — and still get honest elapsed vs labour minutes.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_prep_crew (
        id SERIAL PRIMARY KEY,
        job_id INTEGER NOT NULL,
        employee TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        left_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_prep_crew_job ON inv_prep_crew(job_id);
      CREATE INDEX IF NOT EXISTS idx_prep_crew_open ON inv_prep_crew(employee) WHERE left_at IS NULL;
    `);
    console.log('[Inventory] Prep crew ready.');
  } catch(e) { console.error('prep crew migration skipped:', e.message); }

  // ---- Employees + timecards (idempotent) ----
  // display_name is what the floor picks from a dropdown; homebase_name is the
  // exact string Homebase exports, used to match rows on import.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_employees (
        id SERIAL PRIMARY KEY,
        display_name TEXT NOT NULL UNIQUE,
        homebase_name TEXT,
        wage NUMERIC,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS inv_timecards (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER REFERENCES inv_employees(id) ON DELETE CASCADE,
        homebase_name TEXT,
        work_date DATE NOT NULL,
        clock_in TIMESTAMPTZ NOT NULL,
        clock_out TIMESTAMPTZ NOT NULL,
        break_minutes INTEGER DEFAULT 0,
        wage NUMERIC,
        actual_hours NUMERIC,
        paid_hours NUMERIC,
        ot_hours NUMERIC,
        source TEXT DEFAULT 'homebase-csv',
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (employee_id, clock_in)
      );
      CREATE INDEX IF NOT EXISTS idx_timecards_emp_date ON inv_timecards(employee_id, work_date);
    `);
    const seed = [['Zaia','ZAIA JELOW'],['Samantha','Samantha Rodriguez'],['Nasser','Nasser Shaba']];
    for (const [disp, hb] of seed) {
      await pool.query(
        `INSERT INTO inv_employees(display_name, homebase_name) VALUES($1,$2)
         ON CONFLICT (display_name) DO UPDATE SET homebase_name=COALESCE(inv_employees.homebase_name,$2)`,
        [disp, hb]);
    }
    console.log('[Inventory] Employees + timecards ready.');
  } catch(e) { console.error('employee migration skipped:', e.message); }

  // ---- Hazmat, keyed by ASIN (idempotent) ----
  // Originally stored on inv_products, which only holds the ~111 products we
  // actually carry. Products to Add is about the ~469 Keepa ASINs we DON'T
  // carry, so those could never hold a flag and every one fell into "unknown".
  // A standalone table lets any ASIN be tagged.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inv_hazmat (
        asin TEXT PRIMARY KEY,
        hazmat BOOLEAN,
        source TEXT,
        detail TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    // carry across anything already tagged on inv_products
    await pool.query(`
      INSERT INTO inv_hazmat(asin, hazmat, source, detail)
      SELECT asin, hazmat, COALESCE(hazmat_source,'manual'), hazmat_detail
      FROM inv_products WHERE hazmat IS NOT NULL
      ON CONFLICT (asin) DO NOTHING`);
    console.log('[Inventory] Hazmat table ready.');
  } catch(e) { console.error('hazmat table migration skipped:', e.message); }

  // ---- Hazmat flags (idempotent) ----
  // hazmat: true / false / NULL(unknown). hazmat_source records who decided —
  // a manual call by the owner always outranks Amazon's declaration.
  try {
    await pool.query(`
      ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS hazmat BOOLEAN;
      ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS hazmat_source TEXT;
      ALTER TABLE inv_products ADD COLUMN IF NOT EXISTS hazmat_detail TEXT;
    `);
    console.log('[Inventory] Hazmat columns ready.');
  } catch(e) { console.error('hazmat migration skipped:', e.message); }

  // ---- Cosmo-map verification columns (idempotent) ----
  // A mapping is only TRUSTED once a physical barcode scan has confirmed it.
  // Everything seeded or hand-picked starts unverified.
  try {
    await pool.query(`
      ALTER TABLE inv_cosmo_map ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
      ALTER TABLE inv_cosmo_map ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
      ALTER TABLE inv_cosmo_map ADD COLUMN IF NOT EXISTS verified_upc TEXT;
      ALTER TABLE inv_cosmo_map ADD COLUMN IF NOT EXISTS source TEXT;
    `);
    console.log('[Inventory] Cosmo-map verification columns ready.');
  } catch(e) { console.error('cosmo verification migration skipped:', e.message); }

  console.log('[Inventory] DB ready.');
}

// ---- Auth middleware ----

// Warehouse gate. Honors AUTH_DISABLED.
function auth(req, res, next) {
  if (AUTH_DISABLED) return next();
  if (safeEq(req.headers['x-app-password'], APP_PASSWORD)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Owner/admin gate. Does NOT honor AUTH_DISABLED, and deliberately does NOT
// accept the app password — warehouse staff hold APP_PASSWORD and must not
// see velocity, margin, or inventory value.
function ownerAuth(req, res, next) {
  if (safeEq(req.headers['x-owner-password'], OWNER_PASSWORD)) return next();
  return res.status(403).json({ error: 'owner access required' });
}

app.post('/api/owner-login', loginLimiter, (req, res) => {
  const pw = req.body && req.body.password;
  if (safeEq(pw, OWNER_PASSWORD)) { clearLoginFails(req); return res.json({ ok: true }); }
  noteLoginFail(req);
  return res.status(401).json({ ok: false });
});

// ---- API ROUTES ----

// login check
app.post('/api/login', loginLimiter, (req, res) => {
  if (AUTH_DISABLED) return res.json({ ok: true, disabled: true });
  const pw = req.body && req.body.password;
  if (safeEq(pw, APP_PASSWORD)) { clearLoginFails(req); return res.json({ ok: true }); }
  noteLoginFail(req);
  return res.status(401).json({ ok: false });
});

// Tell the UI whether the warehouse gate is off (so it can skip the login screen)
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
    `SELECT p.asin, p.sku, p.name, p.upc, p.fnsku, p.image, p.location, p.hazmat, p.hazmat_source, s.onhand, s.transit,
      (
        COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
        + COALESCE((SELECT SUM(pr.qty * b.qty) FROM inv_prepped pr JOIN inv_bundles b ON b.bundle_asin=pr.asin WHERE b.component_asin=p.asin),0)
      )::int AS prepped,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
        + COALESCE((SELECT SUM(pp.qty * b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      )::int AS pending_prep,
      EXISTS(SELECT 1 FROM inv_bundles WHERE component_asin=p.asin) AS is_component,
      EXISTS(SELECT 1 FROM inv_bundles WHERE bundle_asin=p.asin) AS is_bundle
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     ORDER BY p.name`);

  // For each component, find its PARTNER components (the other items in the same duos) + their on-hand
  const partnerRows = await pool.query(`
    SELECT b1.component_asin AS asin,
           b1.bundle_asin AS bundle_asin,
           b2.component_asin AS partner_asin,
           p2.name AS partner_name,
           GREATEST(0,
             COALESCE(s2.onhand,0)
             - (
                 COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=b2.component_asin AND is_duo=false),0)
               + COALESCE((SELECT SUM(pp.qty*bb.qty) FROM inv_pending_prep pp JOIN inv_bundles bb ON bb.bundle_asin=pp.asin WHERE bb.component_asin=b2.component_asin),0)
               )
             - (
                 COALESCE((SELECT qty FROM inv_prepped WHERE asin=b2.component_asin),0)
               + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=b2.component_asin),0)
               )
           )::int AS partner_onhand
    FROM inv_bundles b1
    JOIN inv_bundles b2 ON b1.bundle_asin = b2.bundle_asin AND b1.component_asin <> b2.component_asin
    JOIN inv_products p2 ON p2.asin = b2.component_asin
    LEFT JOIN inv_stock s2 ON s2.asin = b2.component_asin
  `);
  const partnersByAsin = {};
  for (const r of partnerRows.rows) {
    if (!partnersByAsin[r.asin]) partnersByAsin[r.asin] = [];
    // dedupe by partner+bundle combo
    if (!partnersByAsin[r.asin].some(x=>x.asin===r.partner_asin && x.bundle_asin===r.bundle_asin)) {
      partnersByAsin[r.asin].push({ asin: r.partner_asin, name: r.partner_name, onhand: r.partner_onhand, bundle_asin: r.bundle_asin });
    }
  }
  // layer in the last FBA inventory pull (what's already at Amazon)
  let fbaByAsin = {}, fbaAsOf = null;
  try {
    const fc = await pool.query("SELECT data, updated_at FROM inv_cache WHERE cache_key='fba_inventory'");
    if (fc.rows.length) {
      fbaAsOf = fc.rows[0].updated_at;
      for (const f of (fc.rows[0].data||[])) {
        fbaByAsin[f.asin] = {
          fulfillable: f.fba_fulfillable||0,
          inbound: f.fba_inbound||0,
          total: f.fba_total||0
        };
      }
    }
  } catch(e) {}

  // layer in cached Keepa market data (sales rank + monthly sold) for prioritization
  let mByAsin = {};
  try {
    const mkt = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
    if (mkt.rows.length) for (const m of (mkt.rows[0].data||[])) mByAsin[m.asin] = m;
  } catch(e) {}

  const out = rows.map(p => {
    const m = mByAsin[p.asin] || {};
    return {
      ...p,
      partners: partnersByAsin[p.asin] || [],
      salesRank: m.salesRank != null ? m.salesRank : null,
      monthlySold: m.monthlySold != null ? m.monthlySold : null,
      buyBoxPrice: m.buyBoxPrice != null ? m.buyBoxPrice : null,
      sellers: m.offerCount != null ? m.offerCount : null,
      pickPackFee: m.pickPackFee != null ? m.pickPackFee : null,
      referralPct: m.referralPct != null ? m.referralPct : null,
    };
  });
  res.json(out);
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
      // clear prepped ONLY for the specific items that actually shipped (not everything)
      for (const part of parts) {
        await pool.query('UPDATE inv_prepped SET qty = GREATEST(0, qty - $1) WHERE asin=$2', [part.qty, part.asin]);
      }
      // also clear the duo's own prepped entry if we shipped it as a duo
      await pool.query('UPDATE inv_prepped SET qty = GREATEST(0, qty - $1) WHERE asin=$2', [q, matchedAsin]);
      await pool.query('DELETE FROM inv_prepped WHERE qty <= 0');
      done++;
    } else { notfound.push(code); }
  }
  // SAFETY: never wipe the whole prepped list. Only the items that shipped were cleared above.
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
    `SELECT si.shipment_id, si.asin, si.qty, si.qty_received, p.name, p.sku, p.fnsku, p.image
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
// ============================================================
// RECEIPT AUDIT — READ ONLY, WRITES NOTHING
// Paste the paper invoice; compare it against what the database actually holds
// for that order. Catches both historic failure modes at once:
//   * pages lost to the old per-page DELETE bug (lines missing entirely)
//   * quantities that do not match the paper
// Also reports which received units landed on a COLLIDING cosmo number, i.e.
// stock that may sit on the wrong ASIN.
// ============================================================
app.post('/api/invoices/audit', auth, async (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (!text.trim()) return res.status(400).json({ error: 'Paste the invoice text first.' });

  const orders = parseInvoiceText(text);
  if (!orders.size) return res.status(400).json({ error: 'No "FOR ORDER NUMBER:" headers found in that text.' });

  // Cosmo numbers that more than one mapping claims — stock on these is suspect.
  const collRows = await pool.query(
    `SELECT cosmo_num FROM inv_cosmo_map WHERE asin IN (
       SELECT asin FROM inv_cosmo_map WHERE asin IS NOT NULL AND asin <> ''
       GROUP BY asin HAVING COUNT(*) > 1)`);
  const colliding = new Set(collRows.rows.map(r => r.cosmo_num));

  const report = [];
  for (const [orderNumber, o] of orders) {
    // paper side (merged the same way the importer merges)
    const paper = new Map();
    for (const it of o.items) {
      const prev = paper.get(it.cosmo_num);
      if (prev) prev.qty += it.qty_shipped;
      else paper.set(it.cosmo_num, { cosmo_num: it.cosmo_num, description: it.description, qty: it.qty_shipped });
    }

    const inv = await pool.query('SELECT order_number, invoice_date, status FROM inv_invoices WHERE order_number=$1', [orderNumber]);
    const dbRows = await pool.query(
      `SELECT ii.cosmo_num, ii.description, ii.asin, ii.qty_expected, ii.qty_received, p.name
       FROM inv_invoice_items ii LEFT JOIN inv_products p ON p.asin=ii.asin
       WHERE ii.order_number=$1`, [orderNumber]);
    const db = new Map();
    for (const r of dbRows.rows) db.set(r.cosmo_num, r);

    const missing = [], qtyMismatch = [], suspect = [], extra = [];
    for (const [cn, pp] of paper) {
      const d = db.get(cn);
      if (!d) { missing.push({ cosmo_num: cn, description: pp.description, paperQty: pp.qty }); continue; }
      if (d.qty_expected !== pp.qty) {
        qtyMismatch.push({ cosmo_num: cn, description: pp.description, paperQty: pp.qty, dbExpected: d.qty_expected, dbReceived: d.qty_received });
      }
      if (colliding.has(cn) && d.qty_received > 0) {
        suspect.push({ cosmo_num: cn, description: pp.description, received: d.qty_received, asin: d.asin, mappedName: d.name });
      }
    }
    for (const [cn, d] of db) if (!paper.has(cn)) extra.push({ cosmo_num: cn, description: d.description, dbExpected: d.qty_expected });

    const paperUnits = [...paper.values()].reduce((n, x) => n + x.qty, 0);
    const dbExpectedUnits = dbRows.rows.reduce((n, r) => n + (r.qty_expected || 0), 0);
    const dbReceivedUnits = dbRows.rows.reduce((n, r) => n + (r.qty_received || 0), 0);

    report.push({
      orderNumber,
      inDatabase: inv.rows.length > 0,
      status: inv.rows[0] ? inv.rows[0].status : null,
      pages: o.pages,
      paperLines: paper.size, dbLines: dbRows.rows.length,
      paperUnits, dbExpectedUnits, dbReceivedUnits,
      missing, qtyMismatch, extra, suspect,
      clean: inv.rows.length > 0 && missing.length === 0 && qtyMismatch.length === 0 && extra.length === 0
    });
  }
  res.json({ ok: true, report });
});

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

  // Self-healing: for every line we could NOT map to an ASIN, suggest the most
  // likely products by description so the receiver can bind it in one tap —
  // no need to open a case and scan a bottle.
  try {
    const unmapped = rows.filter(r => !r.asin);
    if (unmapped.length) {
      const cat = await pool.query('SELECT asin, name, sku, image, location FROM inv_products ORDER BY name');
      for (const r of unmapped) r.candidates = suggestProducts(r.description, cat.rows);
    }
  } catch (e) {
    console.error('[Match] candidate build failed (non-fatal):', e.message);
  }

  // Attach pallet-location context so check-in can pre-fill known items and
  // flag brand-new ones that still need a slot.
  try {
    const asins = rows.map(r => r.asin).filter(Boolean);
    const ctx = await buildLocationContext(asins);
    for (const r of rows) {
      const c = r.asin ? ctx[r.asin] : null;
      r.location      = c ? c.location   : null;
      r.suggested_loc = c ? c.suggested  : null;
      r.loc_status    = c ? c.status     : 'unmapped';
      r.onhand        = c ? c.onhand     : 0;
      r.available     = c ? c.available  : 0;
      r.pendingPrep   = c ? c.pendingPrep: 0;
      r.prepped       = c ? c.prepped    : 0;
      r.transit       = c ? c.transit    : 0;
      r.is_component  = c ? c.is_component : false;
    }
  } catch (e) {
    console.error('[Location] context build failed (non-fatal):', e.message);
  }

  res.json(rows);
});

// Full rack map + who is sitting where (drives the check-in dropdown)
app.get('/api/locations', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.asin, p.name, p.location, COALESCE(s.onhand,0)::int AS onhand
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin = p.asin
     WHERE p.location IS NOT NULL ORDER BY p.name`);
  const occupants = {};
  for (const r of rows) (occupants[r.location] = occupants[r.location] || []).push(r);
  res.json({ slots: LOCATION_SLOTS, occupants });
});

// Set or clear one product's pallet location
app.post('/api/location', auth, async (req, res) => {
  const { asin, location } = req.body || {};
  if (!asin) return res.status(400).json({ error: 'asin required' });
  if (location === '' || location == null) {
    await pool.query('UPDATE inv_products SET location=NULL WHERE asin=$1', [asin]);
    return res.json({ ok: true, location: null });
  }
  const loc = normLoc(location);
  if (!loc) return res.status(400).json({ error: 'Invalid location — use A-1..A-20 or B-1..B-20.' });
  await pool.query('UPDATE inv_products SET location=$1 WHERE asin=$2', [loc, asin]);
  res.json({ ok: true, location: loc });
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
  const line = await pool.query('SELECT id, cosmo_num, description, qty_expected, qty_received FROM inv_invoice_items WHERE order_number=$1 AND asin=$2 LIMIT 1', [order, asin]);

  if (!line.rows.length) {
    const prod = await pool.query('SELECT asin, name FROM inv_products WHERE asin=$1', [asin]);
    const scannedName = prod.rows[0] ? prod.rows[0].name : '';
    const all = await pool.query(
      `SELECT ii.cosmo_num, ii.description, ii.asin, ii.qty_expected, ii.qty_received, p.name AS mapped_name
       FROM inv_invoice_items ii LEFT JOIN inv_products p ON p.asin=ii.asin
       WHERE ii.order_number=$1`, [order]);

    // ---- CASE 1: there are UNMAPPED lines. The barcode can create the
    // Cosmo# -> ASIN link outright, which is the whole point: one scan per new
    // SKU, ever, and the mapping is barcode-proven rather than typed.
    const unmapped = all.rows.filter(r => !r.asin);
    if (unmapped.length) {
      const ranked = unmapped
        .map(u => ({
          cosmo_num: u.cosmo_num, description: u.description,
          qty_expected: u.qty_expected,
          score: matchScore(u.description, scannedName),
          warnings: crossCheck(u.description, scannedName)
        }))
        .sort((a, b) => (a.warnings.length - b.warnings.length) || (b.score - a.score));
      return res.json({
        ok: false, reason: 'bind_unmapped', code,
        scanned: { asin, name: scannedName || asin },
        candidates: ranked,
        // Only auto-propose a line when it is the sole candidate with no
        // type/size objection — never pre-select something the cross-check
        // already disputes.
        autoPick: (ranked.length === 1 && !ranked[0].warnings.length) ? ranked[0] : null
      });
    }

    // ---- CASE 2: every line is mapped, so one of them is probably mapped WRONG.
    let suspect = null, bestScore = 0;
    for (const o of all.rows) {
      const sc = matchScore(o.description, scannedName);
      if (sc > bestScore && sc >= 0.4) { bestScore = sc; suspect = o; }
    }
    if (suspect) {
      return res.json({
        ok: false, reason: 'mapping_mismatch', code,
        scanned: { asin, name: scannedName || asin },
        suspect: {
          cosmo_num: suspect.cosmo_num, description: suspect.description,
          mapped_asin: suspect.asin, mapped_name: suspect.mapped_name
        },
        confidence: Math.min(99, Math.round(bestScore * 100))
      });
    }
    return res.json({ ok: false, reason: 'not_on_invoice', asin, scannedName });
  }

  await pool.query('UPDATE inv_invoice_items SET qty_received = qty_received + $1 WHERE id=$2', [qty, line.rows[0].id]);

  // The barcode agrees with the mapping -> promote it to VERIFIED.
  let verified = false;
  const cnum = line.rows[0].cosmo_num;
  if (cnum) {
    try {
      const r = await pool.query(
        `UPDATE inv_cosmo_map SET verified=true, verified_at=now(), verified_upc=$1
         WHERE cosmo_num=$2 AND asin=$3 AND verified IS NOT true RETURNING cosmo_num`,
        [normCode(code), cnum, asin]);
      verified = r.rowCount > 0;
      if (verified) console.log(`[Verify] Cosmo# ${cnum} -> ${asin} confirmed by barcode ${code}.`);
    } catch (e) { console.error('[Verify] failed (non-fatal):', e.message); }
  }

  const np = await pool.query('SELECT p.name, ii.qty_expected, ii.qty_received FROM inv_invoice_items ii JOIN inv_products p ON p.asin=ii.asin WHERE ii.id=$1', [line.rows[0].id]);
  res.json({ ok: true, asin, line: np.rows[0], justVerified: verified });
});

// Repoint a cosmo_num at the ASIN a scan proved, and mark it verified.
app.post('/api/cosmo-map/fix', auth, async (req, res) => {
  const { cosmo_num, asin, upc, order } = req.body || {};
  if (!cosmo_num || !asin) return res.status(400).json({ error: 'cosmo_num + asin required' });
  await pool.query(
    `INSERT INTO inv_cosmo_map(cosmo_num, asin, verified, verified_at, verified_upc, source)
     VALUES($1,$2,true,now(),$3,'barcode-fix')
     ON CONFLICT (cosmo_num) DO UPDATE SET asin=$2, verified=true, verified_at=now(), verified_upc=$3, source='barcode-fix'`,
    [cosmo_num, asin, upc ? normCode(upc) : null]);
  // repoint the invoice line(s) using this cosmo_num
  if (order) {
    await pool.query('UPDATE inv_invoice_items SET asin=$1 WHERE order_number=$2 AND cosmo_num=$3', [asin, order, cosmo_num]);
  } else {
    await pool.query('UPDATE inv_invoice_items SET asin=$1 WHERE cosmo_num=$2', [asin, cosmo_num]);
  }
  console.log(`[Verify] Cosmo# ${cosmo_num} REPOINTED to ${asin} by barcode.`);
  res.json({ ok: true });
});

// Mapping health — which cosmo_num -> ASIN links are barcode-proven vs guessed.
app.get('/api/mapping-health', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.cosmo_num, c.asin, c.verified, c.verified_at, c.source,
            p.name, p.image, p.location,
            EXISTS(SELECT 1 FROM inv_bundles WHERE component_asin=c.asin) AS is_component
     FROM inv_cosmo_map c LEFT JOIN inv_products p ON p.asin=c.asin
     ORDER BY c.verified NULLS FIRST, p.name`);
  const total = await pool.query('SELECT COUNT(*)::int AS n FROM inv_products');
  const verified = rows.filter(r => r.verified);
  const unverified = rows.filter(r => !r.verified);
  const orphans = rows.filter(r => !r.name);

  // ---- COLLISIONS ----
  // Cosmoprof issues a separate item number per SIZE and per variant, so two
  // numbers pointing at one ASIN means at least one of them is wrong. This is
  // deterministic — no barcode needed — and it is the highest-signal error in
  // the whole map.
  const coll = await pool.query(
    `SELECT c.asin, p.name, p.image,
            array_agg(c.cosmo_num ORDER BY c.cosmo_num) AS nums,
            COUNT(*)::int AS n
     FROM inv_cosmo_map c LEFT JOIN inv_products p ON p.asin = c.asin
     WHERE c.asin IS NOT NULL AND c.asin <> ''
     GROUP BY c.asin, p.name, p.image
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC, p.name`);

  // Most recent invoice description for each colliding number, so the user can
  // see WHICH is the liter and which is the 10.1oz.
  const descRows = await pool.query(
    `SELECT DISTINCT ON (cosmo_num) cosmo_num, description
     FROM inv_invoice_items WHERE description IS NOT NULL
     ORDER BY cosmo_num, id DESC`);
  const descMap = {};
  for (const d of descRows.rows) descMap[d.cosmo_num] = d.description;

  const collisions = coll.rows.map(c => ({
    asin: c.asin, name: c.name, image: c.image, count: c.n,
    numbers: c.nums.map(nm => ({ cosmo_num: nm, description: descMap[nm] || null }))
  }));

  // ---- UPC COVERAGE ----
  // The barcode is the anchor for everything else, so show exactly how much of
  // the catalog can currently be identified by scanning a bottle.
  const upcStats = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM inv_upcs) AS barcodes,
            (SELECT COUNT(DISTINCT asin)::int FROM inv_upcs) AS products_with_upc`);
  const noUpc = await pool.query(
    `SELECT p.asin, p.name, p.image, p.location,
            EXISTS(SELECT 1 FROM inv_bundles WHERE component_asin=p.asin) AS is_component,
            COALESCE(s.onhand,0)::int AS onhand
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin
     WHERE NOT EXISTS(SELECT 1 FROM inv_upcs u WHERE u.asin=p.asin)
       AND NOT EXISTS(SELECT 1 FROM inv_bundles b WHERE b.bundle_asin=p.asin)
     ORDER BY COALESCE(s.onhand,0) DESC, p.name`);

  res.json({
    mapped: rows.length,
    catalog: total.rows[0].n,
    barcodes: upcStats.rows[0].barcodes,
    productsWithUpc: upcStats.rows[0].products_with_upc,
    productsWithoutUpc: noUpc.rows.length,
    missingUpc: noUpc.rows,
    verifiedCount: verified.length,
    unverifiedCount: unverified.length,
    orphanCount: orphans.length,
    collisionCount: collisions.length,
    collisions,
    unmappedProducts: total.rows[0].n - rows.length,
    rows
  });
});

// ============================================================
// REFRESH PRODUCT NAMES FROM AMAZON
// inv_products.name is frozen from the original seed file. Brands rewrite
// listings, and a stale title silently breaks invoice description matching.
// Long-running, so it runs as a background job and is PREVIEW-FIRST: nothing
// is written until the user reviews the diffs and applies them.
// ============================================================
let nameJob = { running:false, done:false, error:null, progress:'', changes:[], checked:0, startedAt:null };

app.post('/api/refresh-names/start', auth, async (req, res) => {
  if (nameJob.running) return res.json({ ok:true, already:true });
  nameJob = { running:true, done:false, error:null, progress:'starting…', changes:[], checked:0, startedAt:new Date() };
  res.json({ ok:true });

  (async () => {
    try {
      const { rows } = await pool.query('SELECT asin, name, image FROM inv_products ORDER BY name');
      const asins = rows.map(r => r.asin);
      nameJob.progress = `looking up ${asins.length} products on Amazon…`;
      const live = await getCatalogItems(asins, p => { nameJob.progress = p; });

      const changes = [];
      for (const r of rows) {
        const l = live[r.asin];
        if (!l || l.error || !l.name) continue;
        nameJob.checked++;
        const oldName = (r.name || '').trim();
        const newName = l.name.trim();
        if (newName && newName !== oldName) {
          changes.push({ asin: r.asin, oldName, newName, image: l.image || r.image || null });
        }
      }
      nameJob.changes = changes;
      nameJob.progress = `${changes.length} name change(s) found out of ${nameJob.checked} checked.`;
      nameJob.running = false; nameJob.done = true;
      console.log(`[Names] ${changes.length} of ${nameJob.checked} product titles differ from Amazon.`);
    } catch (e) {
      nameJob.running = false; nameJob.error = e.message;
      console.error('[Names] refresh failed:', e.message);
    }
  })();
});

app.get('/api/refresh-names/status', auth, (req, res) => res.json(nameJob));

// Apply reviewed name changes (optionally a subset, by ASIN).
app.post('/api/refresh-names/apply', auth, async (req, res) => {
  const only = (req.body && Array.isArray(req.body.asins)) ? new Set(req.body.asins) : null;
  let applied = 0;
  for (const c of nameJob.changes) {
    if (only && !only.has(c.asin)) continue;
    await pool.query('UPDATE inv_products SET name=$1 WHERE asin=$2', [c.newName, c.asin]);
    if (c.image) await pool.query("UPDATE inv_products SET image=$1 WHERE asin=$2 AND (image IS NULL OR image='')", [c.image, c.asin]);
    applied++;
  }
  nameJob.changes = nameJob.changes.filter(c => only ? !only.has(c.asin) : false);
  console.log(`[Names] Applied ${applied} title updates.`);
  res.json({ ok:true, applied });
});

// Before a barcode is bound to a product, check that product against every line
// on the invoice. If it conflicts with ALL of them on type or size, the person
// is probably about to assign the wrong item.
app.post('/api/upc-precheck', auth, async (req, res) => {
  const { asin, order } = req.body || {};
  if (!asin) return res.status(400).json({ error: 'asin required' });
  const prod = await pool.query('SELECT asin, name FROM inv_products WHERE asin=$1', [asin]);
  if (!prod.rows.length) return res.status(404).json({ error: 'product not found' });
  const name = prod.rows[0].name || '';

  if (!order) return res.json({ ok: true, name, lines: [], anyCompatible: true });

  const lines = await pool.query(
    'SELECT cosmo_num, description, asin FROM inv_invoice_items WHERE order_number=$1', [order]);

  const checked = lines.rows.map(l => ({
    cosmo_num: l.cosmo_num, description: l.description, alreadyLinked: !!l.asin,
    warnings: crossCheck(l.description, name),
    score: matchScore(l.description, name)
  })).sort((a, b) => (a.warnings.length - b.warnings.length) || (b.score - a.score));

  const compatible = checked.filter(c => c.warnings.length === 0);
  res.json({
    ok: true, name,
    lines: checked.slice(0, 6),
    anyCompatible: compatible.length > 0,
    best: compatible[0] || checked[0] || null
  });
});

// ============================================================
// COST ENGINE
// regular_cost = the price paid for the LARGEST share of units. Cosmoprof runs
//                sales roughly twice a year, so the price behind most of the
//                volume is the standing price, not the cheapest one seen.
// avg_cost     = weighted average across every lot = what the stock actually
//                cost. This is the number margin should be measured against.
// A lot is "on sale" when it is meaningfully under the regular price.
// ============================================================
const SALE_THRESHOLD = 0.97;   // >3% under regular counts as a sale lot

function blendCosts(lots) {
  if (!lots.length) return null;
  // regular = cost carrying the most units
  const byCost = {};
  for (const l of lots) {
    const c = Number(l.unit_cost).toFixed(4);
    byCost[c] = (byCost[c] || 0) + (l.qty || 0);
  }
  let regular = null, bestQty = -1;
  for (const c of Object.keys(byCost)) {
    if (byCost[c] > bestQty) { bestQty = byCost[c]; regular = parseFloat(c); }
  }
  let spend = 0, units = 0, saleUnits = 0, saleSpend = 0, regUnits = 0, regSpend = 0;
  const priced = lots.map(l => {
    const cost = Number(l.unit_cost), qty = l.qty || 0;
    const onSale = cost < regular * SALE_THRESHOLD;
    spend += cost * qty; units += qty;
    if (onSale) { saleUnits += qty; saleSpend += cost * qty; }
    else { regUnits += qty; regSpend += cost * qty; }
    return { ...l, unit_cost: cost, onSale };
  });
  return {
    regular,
    avg: units ? spend / units : regular,
    units, spend,
    saleUnits, saleSpend, regUnits, regSpend,
    lowestSale: saleUnits ? Math.min(...priced.filter(l => l.onSale).map(l => l.unit_cost)) : null,
    saved: regUnits || saleUnits ? (regular * saleUnits - saleSpend) : 0,
    lots: priced.sort((a, b) => String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')))
  };
}

// Recompute blended costs for every ASIN that has purchase history.
async function recomputeCosts() {
  const { rows } = await pool.query('SELECT asin, order_number, invoice_date, unit_cost, qty FROM inv_cost_history WHERE qty > 0');
  const byAsin = {};
  for (const r of rows) (byAsin[r.asin] = byAsin[r.asin] || []).push(r);
  let n = 0;
  for (const asin of Object.keys(byAsin)) {
    const b = blendCosts(byAsin[asin]);
    if (!b) continue;
    await pool.query('UPDATE inv_products SET avg_cost=$1, regular_cost=$2, unit_cost=$3 WHERE asin=$4',
      [b.avg, b.regular, b.avg, asin]);
    n++;
  }
  console.log(`[Costs] Reblended ${n} products from ${rows.length} purchase lots.`);
  return n;
}

// Build cost history from invoice lines already in the database.
// Lots are only captured when a check-in COMPLETES, so every invoice received
// before that feature existed has its costs sitting unused in inv_invoice_items.
// This backfills them. It never touches stock.
app.post('/api/costs/backfill', ownerAuth, async (req, res) => {
  try {
    const includePending = !!(req.body && req.body.includePending);
    const { rows } = await pool.query(`
      SELECT ii.asin, ii.order_number, i.invoice_date, ii.unit_cost,
             GREATEST(COALESCE(ii.qty_received,0), CASE WHEN $1 THEN COALESCE(ii.qty_expected,0) ELSE 0 END) AS qty
      FROM inv_invoice_items ii
      JOIN inv_invoices i ON i.order_number = ii.order_number
      WHERE ii.asin IS NOT NULL AND ii.unit_cost IS NOT NULL
        AND ($1 OR i.status = 'received')`, [includePending]);

    let inserted = 0, skippedNoQty = 0;
    for (const r of rows) {
      const qty = parseInt(r.qty, 10) || 0;
      if (qty <= 0) { skippedNoQty++; continue; }
      await pool.query(
        `INSERT INTO inv_cost_history(asin, order_number, invoice_date, unit_cost, qty)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (order_number, asin) DO UPDATE SET unit_cost=$4, qty=$5, invoice_date=$3`,
        [r.asin, r.order_number, r.invoice_date, r.unit_cost, qty]);
      inserted++;
    }
    const products = await recomputeCosts();
    console.log(`[Costs] Backfilled ${inserted} lots (${skippedNoQty} had no quantity).`);
    res.json({ ok: true, lots: inserted, skippedNoQty, products, candidates: rows.length });
  } catch (e) {
    console.error('[Costs] backfill failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/costs/recompute', ownerAuth, async (req, res) => {
  try { const n = await recomputeCosts(); res.json({ ok: true, products: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Full cost + margin picture per product.
app.get('/api/cost-analysis', ownerAuth, async (req, res) => {
  const hist = await pool.query('SELECT asin, order_number, invoice_date, unit_cost, qty FROM inv_cost_history WHERE qty > 0');
  const byAsin = {};
  for (const r of hist.rows) (byAsin[r.asin] = byAsin[r.asin] || []).push(r);

  const prods = await pool.query('SELECT asin, name, image, sku FROM inv_products');
  const nameByAsin = {}; for (const p of prods.rows) nameByAsin[p.asin] = p;

  // market price + Amazon fees from the Keepa cache
  let mkt = {};
  try {
    const c = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
    if (c.rows.length) for (const m of (c.rows[0].data || [])) mkt[m.asin] = m;
  } catch (e) {}
  // units actually sold, from the velocity cache
  let soldByAsin = {};
  try {
    const c = await pool.query("SELECT data FROM inv_cache WHERE cache_key='velocity'");
    const items = c.rows.length ? (c.rows[0].data?.items || []) : [];
    for (const v of items) if (v.asin) soldByAsin[v.asin] = { sold: v.sold || 0, perDay: v.perDay || 0 };
  } catch (e) {}
  const velDays = 30;

  const out = [];
  let totalSpend = 0, totalUnits = 0, totalSaved = 0;
  for (const asin of Object.keys(byAsin)) {
    const b = blendCosts(byAsin[asin]);
    const p = nameByAsin[asin] || {};
    const m = mkt[asin] || {};
    const price = m.buyBoxPrice || null;
    const refPct = (m.referralPct != null ? m.referralPct : 15) / 100;
    const fbaFee = m.pickPackFee != null ? m.pickPackFee : null;
    const net = price ? Math.max(0, price - price * refPct - (fbaFee || 0)) : null;
    const profitUnit = (net != null && b.avg != null) ? net - b.avg : null;
    const marginPct = (profitUnit != null && price) ? (profitUnit / price) * 100 : null;
    const roi = (profitUnit != null && b.avg) ? (profitUnit / b.avg) * 100 : null;
    const sold = soldByAsin[asin] ? soldByAsin[asin].sold : 0;

    totalSpend += b.spend; totalUnits += b.units; totalSaved += (b.saved || 0);
    out.push({
      asin, name: p.name || asin, image: p.image || null, sku: p.sku || '',
      regularCost: b.regular, avgCost: b.avg, lowestSale: b.lowestSale,
      units: b.units, spend: b.spend,
      regUnits: b.regUnits, saleUnits: b.saleUnits, saved: b.saved,
      lots: b.lots.slice(0, 12),
      price, feesEstimated: (m.referralPct == null || m.pickPackFee == null),
      netDeposit: net, profitUnit, marginPct, roi,
      soldLast30: sold,
      profitLast30: (profitUnit != null) ? profitUnit * sold : null
    });
  }
  out.sort((a, b2) => (b2.profitLast30 || 0) - (a.profitLast30 || 0));

  // If there is nothing to show, say exactly why rather than rendering blank.
  let diag = null;
  if (!out.length) {
    try {
      const q = async (sql, params=[]) => (await pool.query(sql, params)).rows[0];
      const lots   = await q('SELECT COUNT(*)::int AS n FROM inv_cost_history');
      const lines  = await q('SELECT COUNT(*)::int AS n FROM inv_invoice_items');
      const costed = await q('SELECT COUNT(*)::int AS n FROM inv_invoice_items WHERE unit_cost IS NOT NULL');
      const mapped = await q('SELECT COUNT(*)::int AS n FROM inv_invoice_items WHERE unit_cost IS NOT NULL AND asin IS NOT NULL');
      const recvd  = await q("SELECT COUNT(*)::int AS n FROM inv_invoices WHERE status='received'");
      const withQty= await q('SELECT COUNT(*)::int AS n FROM inv_invoice_items WHERE unit_cost IS NOT NULL AND asin IS NOT NULL AND COALESCE(qty_received,0) > 0');
      diag = {
        costLots: lots.n, invoiceLines: lines.n, linesWithCost: costed.n,
        linesWithCostAndAsin: mapped.n, linesReadyToBackfill: withQty.n,
        receivedInvoices: recvd.n
      };
    } catch (e) { diag = { error: e.message }; }
  }

  res.json({
    items: out, diag,
    totals: {
      spend: totalSpend, units: totalUnits, saved: totalSaved,
      avgCost: totalUnits ? totalSpend / totalUnits : null,
      profitLast30: out.reduce((n, x) => n + (x.profitLast30 || 0), 0),
      velDays
    }
  });
});

// ============================================================
// SETTLEMENT REPORTS — real fees, real refunds
// Amazon's flat-file settlement is tab separated. Every row is one money
// movement, classified by amount-type / amount-description:
//   ItemPrice  + Principal                  -> gross revenue
//   ItemFees   + Commission                 -> referral fee
//   ItemFees   + FBAPerUnitFulfillmentFee   -> FBA pick & pack
//   ItemPrice  + Principal (Refund)         -> money returned to the customer
//   ItemFees   + RefundCommission           -> the bit Amazon keeps on a refund
// Fees are reported as NEGATIVE numbers; they are stored exactly as reported.
// ============================================================
function parseSettlementFlatFile(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { header: null, rows: [] };

  // Header names differ between variants and marketplaces: 'amount-type',
  // 'Amount Type', 'amount_type'. Normalise both sides to letters+digits.
  const rawCols = lines[0].split('\t').map(c => c.trim());
  const cols = rawCols.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const at = (name) => cols.indexOf(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));

  const iSet = at('settlement-id'), iStart = at('settlement-start-date'), iEnd = at('settlement-end-date');
  const iDep = at('deposit-date'), iTotal = at('total-amount');
  const iTxn = at('transaction-type'), iOrder = at('order-id'), iSku = at('sku');
  const iShip = at('shipment-id');
  const iQty = at('quantity-purchased'), iPosted = at('posted-date');

  // TALL layout (V2): one amount per row.
  const iType = at('amount-type'), iDesc = at('amount-description'), iAmt = at('amount');
  // WIDE layout (V1): several typed amounts per row, each its own column pair.
  const PAIRS = [
    { type: at('price-type'),            amt: at('price-amount'),            kind: 'ItemPrice' },
    { type: at('item-related-fee-type'), amt: at('item-related-fee-amount'), kind: 'ItemFees'  },
    { type: at('shipment-fee-type'),     amt: at('shipment-fee-amount'),     kind: 'ItemFees'  },
    { type: at('order-fee-type'),        amt: at('order-fee-amount'),        kind: 'ItemFees'  },
    { type: at('promotion-type'),        amt: at('promotion-amount'),        kind: 'Promotion' },
    { type: at('direct-payment-type'),   amt: at('direct-payment-amount'),   kind: 'other-transaction' },
  ];
  // Amounts with no type column of their own.
  const iMisc = at('misc-fee-amount');
  const iOtherFee = at('other-fee-amount'), iOtherReason = at('other-fee-reason-description');
  const iOtherAmt = at('other-amount');

  const isWide = PAIRS.some(p2 => p2.type >= 0 && p2.amt >= 0) || iOtherFee >= 0;
  const isTall = iType >= 0 && iAmt >= 0;

  console.log('[Settlement] columns:', JSON.stringify(rawCols));
  console.log(`[Settlement] layout detected: ${isWide ? 'WIDE (flat file v1)' : (isTall ? 'TALL (v2)' : 'UNKNOWN')}`);
  if (!isWide && !isTall) console.error('[Settlement] neither layout recognised — no amount columns found.');

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const date = (v) => {
    const t = String(v || '').trim();
    if (!t) return null;
    const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);         // 2026-08-29T13:34:05+00:00
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const m = t.match(/^(\d{1,2})[-\/.]([A-Za-z]{3}|\d{1,2})[-\/.](\d{4})/);
    if (m) {
      const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const mo = isNaN(+m[2]) ? MON[m[2].toLowerCase()] : (+m[2] - 1);
      if (mo != null) return `${m[3]}-${String(mo+1).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  let header = null;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    const settlementId = (f[iSet] || '').trim();
    if (!settlementId) continue;

    // The first row carries the settlement totals and no transaction detail.
    if (!header && iTotal >= 0 && f[iTotal] && String(f[iTotal]).trim()) {
      header = {
        settlement_id: settlementId,
        start_date: date(f[iStart]), end_date: date(f[iEnd]),
        deposit_date: date(f[iDep]), total_amount: num(f[iTotal])
      };
    }

    const base = {
      settlement_id: settlementId,
      posted_date: date(f[iPosted]) || (header && header.end_date) || null,
      transaction_type: (f[iTxn] || '').trim() || null,
      order_id: (f[iOrder] || '').trim() || null,
      shipment_id: iShip >= 0 ? ((f[iShip] || '').trim() || null) : null,
      sku: (f[iSku] || '').trim() || null,
      quantity: iQty >= 0 ? (parseInt(f[iQty], 10) || 0) : 0,
      deposit_date: header ? header.deposit_date : null
    };

    if (isTall) {
      const amt = num(f[iAmt]);
      if (amt == null) continue;
      rows.push({ ...base, row_idx: rows.length,
        amount_type: (f[iType] || '').trim() || null,
        amount_description: (f[iDesc] || '').trim() || null,
        amount: amt });
      continue;
    }

    // WIDE: emit one row per populated (type, amount) pair on this line.
    let emitted = 0;
    for (const pr of PAIRS) {
      if (pr.amt < 0) continue;
      const amt = num(f[pr.amt]);
      if (amt == null || amt === 0) continue;
      const desc = (pr.type >= 0 ? (f[pr.type] || '').trim() : '') || pr.kind;
      rows.push({ ...base, row_idx: rows.length, amount_type: pr.kind, amount_description: desc, amount: amt });
      emitted++;
      // quantity belongs to the sale line only, never to a fee
      if (pr.kind !== 'ItemPrice') rows[rows.length - 1].quantity = 0;
    }
    if (iMisc >= 0) {
      const a = num(f[iMisc]);
      if (a != null && a !== 0) { rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'ItemFees', amount_description: 'MiscFee', amount: a }); emitted++; }
    }
    if (iOtherFee >= 0) {
      const a = num(f[iOtherFee]);
      if (a != null && a !== 0) {
        const reason = (iOtherReason >= 0 ? (f[iOtherReason] || '').trim() : '') || 'OtherFee';
        // Inbound transport / placement fees arrive here.
        rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'other-transaction', amount_description: reason, amount: a });
        emitted++;
      }
    }
    if (iOtherAmt >= 0) {
      const a = num(f[iOtherAmt]);
      if (a != null && a !== 0) {
        rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'other-transaction',
                    amount_description: base.transaction_type || 'Other', amount: a });
        emitted++;
      }
    }
  }

  if (!header) header = { settlement_id: rows.length ? rows[0].settlement_id : null,
                          start_date: null, end_date: null, deposit_date: null, total_amount: null };
  return { header, rows };
}

let settleJob = { running:false, done:false, error:null, progress:'', reports:0, imported:0, lines:0 };

app.post('/api/settlements/sync', ownerAuth, async (req, res) => {
  if (settleJob.running) return res.json({ ok:true, already:true });
  const sinceDays = Number(req.body && req.body.sinceDays) || 180;
  // Amazon throttles getReportDocument to roughly one call per minute and the
  // bucket stays drained after a burst. Fetch a few per run; re-run to continue.
  const maxReports = Math.max(1, Math.min(20, Number(req.body && req.body.maxReports) || 3));
  // force: re-download and re-parse settlements already marked imported. Needed
  // when a parser fix means the stored lines were wrong (or absent).
  const force = !!(req.body && req.body.force);
  settleJob = { running:true, done:false, error:null, progress:'listing reports…', reports:0, imported:0, lines:0, attempts:[], skipped:0 };
  console.log(`[Settlement] SYNC STARTED — window ${sinceDays} days, max ${maxReports} report(s) this run.`);
  res.json({ ok:true });

  (async () => {
    try {
      const listed = await listSettlementReports(sinceDays);
      const reports = listed.reports || [];
      settleJob.attempts = listed.attempts || [];
      settleJob.reports = reports.length;
      if (!reports.length) {
        const errs = settleJob.attempts.filter(a => a.error);
        const denied = errs.find(a => /403|Access to requested resource is denied|Unauthorized/i.test(a.error || ''));
        console.error('[Settlement] NO REPORTS RETURNED. Attempts: ' + JSON.stringify(settleJob.attempts));
        settleJob.progress = denied
          ? 'Amazon refused access to settlement reports. Your SP-API app needs the Finance and Accounting role — add it in Seller Central under Apps & Services → Develop Apps, then re-authorise.'
          : (errs.length
              ? 'Amazon returned an error listing settlement reports — see the detail below.'
              : 'Amazon listed no settlement reports at all. If this account has had a disbursement, the app may lack the Finance and Accounting role.');
        settleJob.running = false; settleJob.done = true; return;
      }
      // Skip settlements already stored — by REPORT ID, before downloading.
      // getReportDocument is limited to about one call per minute, so spending
      // it on a report we already have is the most expensive mistake possible.
      let known = new Set(), knownReports = new Set();
      try {
        const have = await pool.query('SELECT settlement_id FROM inv_settlements');
        known = new Set(have.rows.map(r => r.settlement_id));
        console.log(`[Settlement] ${known.size} settlement(s) already stored.`);
      } catch (e) {
        console.error('[Settlement] could not read inv_settlements:', e.message);
      }
      try {
        const doneReports = await pool.query("SELECT report_id FROM inv_settlement_reports WHERE status='imported'");
        knownReports = new Set(doneReports.rows.map(r => r.report_id));
        console.log(`[Settlement] ${knownReports.size} report(s) previously imported.`);
      } catch (e) {
        // Missing table would otherwise abort the whole run silently.
        console.error('[Settlement] could not read inv_settlement_reports:', e.message);
        try {
          await pool.query(`CREATE TABLE IF NOT EXISTS inv_settlement_reports (
            report_id TEXT PRIMARY KEY, settlement_id TEXT, status TEXT, seen_at TIMESTAMPTZ DEFAULT now())`);
          console.log('[Settlement] created inv_settlement_reports on the fly.');
        } catch (e2) { console.error('[Settlement] create failed:', e2.message); }
      }

      const pending = force ? reports.slice() : reports.filter(r => !knownReports.has(r.reportId));
      if (force) console.log('[Settlement] FORCE re-import — ignoring previously imported markers.');
      const todo = pending.slice(0, maxReports);
      settleJob.skipped = reports.length - pending.length;
      settleJob.remaining = Math.max(0, pending.length - todo.length);
      if (!todo.length) {
        console.log(`[Settlement] nothing to do — all ${reports.length} report(s) already imported.`);
        settleJob.progress = `All ${reports.length} report(s) already imported.`;
        settleJob.running = false; settleJob.done = true; return;
      }

      console.log(`[Settlement] ${reports.length} listed, ${pending.length} not yet imported, downloading ${todo.length} this run (about 1 per minute).`);
      let n2 = 0;
      for (const rep of todo) {
        n2++;
        const n = n2;
        console.log(`[Settlement] downloading ${n2}/${todo.length} — report ${rep.reportId} (${rep.start || '?'} to ${rep.end || '?'})`);
        const mins = Math.max(0, Math.round((todo.length - n2) * 1.1));
        settleJob.progress = `report ${n2} of ${todo.length}` + (mins ? ` · about ${mins} min left (Amazon limits this to ~1 per minute)` : '');
        let text;
        try { text = await downloadReportDocument(rep.documentId, m => { settleJob.progress = `report ${n2} of ${todo.length} — ${m}`; }); }
        catch (e) {
          console.error('[Settlement] download failed:', e.message);
          settleJob.failed = (settleJob.failed || 0) + 1;
          continue;
        }
        await pool.query(
          `INSERT INTO inv_settlement_reports(report_id, status) VALUES($1,'downloaded')
           ON CONFLICT (report_id) DO UPDATE SET status='downloaded', seen_at=now()`, [rep.reportId]);

        console.log(`[Settlement] downloaded ${text.length} chars; parsing…`);
        const { header, rows } = parseSettlementFlatFile(text);
        console.log(`[Settlement] parsed settlement ${header && header.settlement_id} with ${rows.length} row(s).`);
        if (!header || !header.settlement_id) {
          console.error('[Settlement] no settlement id in that file — skipping.');
          continue;
        }
        if (!force && known.has(header.settlement_id)) {
          await pool.query(
            `INSERT INTO inv_settlement_reports(report_id, settlement_id, status) VALUES($1,$2,'imported')
             ON CONFLICT (report_id) DO UPDATE SET settlement_id=$2, status='imported'`,
            [rep.reportId, header.settlement_id]);
          settleJob.skipped++;
          settleJob.progress = `settlement ${header.settlement_id} already on file`;
          if (n2 < todo.length) await new Promise(r => setTimeout(r, 62000));
          continue;
        }

        // resolve SKU -> ASIN once per settlement
        const skuMap = {};
        try {
          const pr = await pool.query('SELECT sku, asin FROM inv_products WHERE sku IS NOT NULL');
          for (const r of pr.rows) skuMap[String(r.sku).toLowerCase()] = r.asin;
        } catch (e) {}

        // BATCHED INSERT. One row at a time meant ~8,400 round-trips per
        // settlement and ~50,000 across the set — slow enough that a run never
        // finished. 500 rows per statement is ~5,500 parameters, well inside
        // Postgres's 65,535 limit.
        if (force) {
          const del = await pool.query('DELETE FROM inv_settlement_lines WHERE settlement_id=$1', [header.settlement_id]);
          if (del.rowCount) console.log(`[Settlement] cleared ${del.rowCount} old line(s) for ${header.settlement_id}.`);
        }
        let inserted = 0;
        const CHUNK = 500;
        for (let off = 0; off < rows.length; off += CHUNK) {
          const slice = rows.slice(off, off + CHUNK);
          const vals = [], params = [];
          let n = 0;
          for (const r of slice) {
            const asin = r.sku ? (skuMap[r.sku.toLowerCase()] || null) : null;
            vals.push(`($${n+1},$${n+2},$${n+3},$${n+4},$${n+5},$${n+6},$${n+7},$${n+8},$${n+9},$${n+10},$${n+11},$${n+12})`);
            params.push(r.settlement_id, r.posted_date, r.transaction_type, r.order_id, r.sku, asin,
                        r.amount_type, r.amount_description, r.amount, r.quantity, r.deposit_date, r.row_idx);
            n += 12;
          }
          try {
            const res2 = await pool.query(
              `INSERT INTO inv_settlement_lines(settlement_id, posted_date, transaction_type, order_id, sku, asin,
                 amount_type, amount_description, amount, quantity, deposit_date, row_idx)
               VALUES ${vals.join(',')}
               ON CONFLICT (settlement_id, row_idx) DO UPDATE SET
                 posted_date=EXCLUDED.posted_date, transaction_type=EXCLUDED.transaction_type,
                 order_id=EXCLUDED.order_id, sku=EXCLUDED.sku, asin=EXCLUDED.asin,
                 amount_type=EXCLUDED.amount_type, amount_description=EXCLUDED.amount_description,
                 amount=EXCLUDED.amount, quantity=EXCLUDED.quantity, deposit_date=EXCLUDED.deposit_date`, params);
            inserted += res2.rowCount || 0;
          } catch (e) {
            console.error(`[Settlement] batch insert failed at row ${off}: ${e.message}`);
          }
          if (off % 2000 === 0) {
            settleJob.progress = `report ${n2}/${todo.length} — storing ${off + slice.length}/${rows.length} lines…`;
          }
        }
        await pool.query(
          `INSERT INTO inv_settlements(settlement_id, start_date, end_date, deposit_date, total_amount, lines)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (settlement_id) DO UPDATE SET lines=$6, total_amount=$5`,
          [header.settlement_id, header.start_date, header.end_date, header.deposit_date, header.total_amount, inserted]);

        // ---- Inbound freight / placement fees ----
        // These are charged per SHIPMENT, not per sale, so they carry no SKU.
        // Auto-attach when Amazon names the shipment; otherwise park them for
        // one-tap linking. Either way they are recorded ONCE, as 'actual',
        // which supersedes whatever was typed in as an estimate.
        try {
          for (const r of rows) {
            const desc = r.amount_description || '';
            if (!INBOUND_FEE_PATTERNS.test(desc)) continue;
            // The wide flat file has a real shipment-id column; fall back to
            // order-id only for layouts that lack it.
            const shipRef = (r.shipment_id || r.order_id || '').trim();
            let linked = null;
            if (shipRef) {
              const m = await pool.query('SELECT shipment_id FROM inv_shipments WHERE shipment_id=$1', [shipRef]);
              if (m.rows.length) linked = shipRef;
            }
            if (linked) {
              const kind = /placement/i.test(desc) ? 'placement' : 'freight';
              // Keep what was typed and record the gap. A figure pulled from a
              // completed Amazon shipment is usually right; a real difference
              // means a reweigh or recalculation and is worth seeing, not hiding.
              await pool.query(
                `INSERT INTO inv_shipment_costs(shipment_id, kind, amount, source, settlement_id, note, updated_at)
                 VALUES($1,$2,$3,'actual',$4,$5,now())
                 ON CONFLICT (shipment_id, kind) DO UPDATE SET
                   amount=$3, source='actual', settlement_id=$4, note=$5, updated_at=now(),
                   variance = CASE WHEN inv_shipment_costs.entered_amount IS NOT NULL
                                   AND ABS(inv_shipment_costs.entered_amount - $3) > 0.01
                              THEN $3 - inv_shipment_costs.entered_amount ELSE NULL END`,
                [linked, kind, Math.abs(Number(r.amount)), header.settlement_id, desc]);
            } else {
              await pool.query(
                `INSERT INTO inv_unlinked_fees(settlement_id, posted_date, description, amount, raw_shipment_id)
                 VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                [header.settlement_id, r.posted_date, desc, r.amount, shipRef || null]);
            }
          }
        } catch (e) { console.error('[Settlement] inbound fee capture failed:', e.message); }

        await pool.query(
          `INSERT INTO inv_settlement_reports(report_id, settlement_id, status) VALUES($1,$2,'imported')
           ON CONFLICT (report_id) DO UPDATE SET settlement_id=$2, status='imported', seen_at=now()`,
          [rep.reportId, header.settlement_id]);
        await pool.query('UPDATE inv_settlements SET report_id=$1 WHERE settlement_id=$2', [rep.reportId, header.settlement_id]);

        settleJob.imported++; settleJob.lines += inserted;
        if (!inserted) console.error(`[Settlement] ${header.settlement_id}: parsed ${rows.length} row(s) but stored 0 — check the column list above.`);
        console.log(`[Settlement] ${header.settlement_id}: ${inserted} line(s) stored from ${rows.length} parsed.`);
        // stay under the ~1/min document limit on the next loop
        if (n2 < todo.length) await new Promise(r => setTimeout(r, 62000));
      }
      settleJob.progress = `${settleJob.imported} settlement(s) imported, ${settleJob.lines} lines`
        + (settleJob.skipped ? `, ${settleJob.skipped} already on file` : '')
        + (settleJob.failed ? `, ${settleJob.failed} still rate-limited` : '')
        + (settleJob.remaining ? `. ${settleJob.remaining} report(s) left — run it again to continue` : '.');
      settleJob.running = false; settleJob.done = true;
    } catch (e) {
      settleJob.running = false; settleJob.error = e.message;
      console.error('[Settlement] SYNC FAILED:', e.message, e.stack ? e.stack.split('\n')[1] : '');
    }
  })();
});

app.get('/api/settlements/status', ownerAuth, (req, res) => res.json({ ...settleJob, build: BUILD_ID }));

// Real, per-ASIN economics over a date range, straight from the settlements.
app.get('/api/settlements/summary', ownerAuth, async (req, res) => {
  const from = req.query.from || null, to = req.query.to || null;
  const where = [], params = [];
  if (from) { params.push(from); where.push(`posted_date >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`posted_date <= $${params.length}`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT asin, sku, amount_type, amount_description, transaction_type,
            SUM(amount)::numeric AS total, SUM(quantity)::int AS units
     FROM inv_settlement_lines ${clause}
     GROUP BY asin, sku, amount_type, amount_description, transaction_type`, params);

  const isRefund = (t) => /refund/i.test(t || '');
  const byAsin = {};
  let grand = { revenue:0, fees:0, refunds:0, refundFees:0, other:0, units:0 };

  for (const r of rows) {
    const key = r.asin || ('sku:' + (r.sku || 'unknown'));
    const a = byAsin[key] = byAsin[key] || {
      asin: r.asin, sku: r.sku, revenue:0, fees:0, refunds:0, refundFees:0,
      other:0, units:0, unitsRefunded:0, feeBreakdown:{}
    };
    const amt = Number(r.total) || 0;
    const desc = r.amount_description || 'Other';

    if (r.amount_type === 'ItemPrice' && !isRefund(r.transaction_type)) {
      a.revenue += amt; a.units += (r.units || 0); grand.revenue += amt; grand.units += (r.units || 0);
    } else if (r.amount_type === 'ItemPrice' && isRefund(r.transaction_type)) {
      a.refunds += amt; a.unitsRefunded += Math.abs(r.units || 0); grand.refunds += amt;
    } else if (r.amount_type === 'ItemFees' && !isRefund(r.transaction_type)) {
      a.fees += amt; grand.fees += amt;
      a.feeBreakdown[desc] = (a.feeBreakdown[desc] || 0) + amt;
    } else if (r.amount_type === 'ItemFees' && isRefund(r.transaction_type)) {
      a.refundFees += amt; grand.refundFees += amt;
      a.feeBreakdown[desc] = (a.feeBreakdown[desc] || 0) + amt;
    } else if (INBOUND_FEE_PATTERNS.test(desc)) {
      // Recorded against the SHIPMENT and allocated per unit there. Counting it
      // here as well would charge the same freight twice.
      grand.inbound = (grand.inbound || 0) + amt;
    } else {
      a.other += amt; grand.other += amt;
    }
  }

  // blend in what the stock cost and what it cost to prep
  const costs = {};
  try {
    const c = await pool.query('SELECT asin, avg_cost FROM inv_products WHERE avg_cost IS NOT NULL');
    for (const r of c.rows) costs[r.asin] = Number(r.avg_cost);
  } catch (e) {}
  const names = {};
  try {
    const n = await pool.query('SELECT asin, name FROM inv_products');
    for (const r of n.rows) names[r.asin] = r.name;
  } catch (e) {}

  const items = Object.values(byAsin).map(a => {
    const netSales = a.revenue + a.refunds;                 // refunds are negative
    const allFees  = a.fees + a.refundFees + a.other;       // fees are negative
    const deposited = netSales + allFees;
    const netUnits = Math.max(0, a.units - a.unitsRefunded);
    const cogs = costs[a.asin] != null ? costs[a.asin] * netUnits : null;
    const profit = cogs != null ? deposited - cogs : null;
    return {
      ...a,
      name: names[a.asin] || a.sku || a.asin,
      netSales, allFees, deposited, netUnits,
      avgCost: costs[a.asin] != null ? costs[a.asin] : null,
      cogs, profit,
      marginPct: (profit != null && netSales) ? (profit / netSales) * 100 : null,
      feePctOfSales: netSales ? (Math.abs(allFees) / netSales) * 100 : null,
      refundRate: a.units ? (a.unitsRefunded / a.units) * 100 : 0
    };
  }).sort((x, y) => (y.profit || -1e12) - (x.profit || -1e12));

  const cover = await pool.query(
    'SELECT MIN(posted_date) AS first_day, MAX(posted_date) AS last_day, COUNT(DISTINCT settlement_id)::int AS settlements FROM inv_settlement_lines');

  res.json({ items, grand, coverage: cover.rows[0] });
});

// ============================================================
// HOMEBASE TIMESHEET IMPORT
// The Homebase API is Enterprise-only ($120/mo). The CSV export carries the
// same fields we need — per-person punches and wage — so it is uploaded once
// per pay period instead. Punches are what prep-job durations get clamped to,
// which is how a job left open overnight stops reading as 17 hours.
// ============================================================

// Minimal RFC4180-ish CSV line splitter (handles quoted fields with commas).
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out.map(x => x.trim());
}

const HB_MONTHS = {january:0,february:1,march:2,april:3,may:4,june:5,july:6,
                   august:7,september:8,october:9,november:10,december:11,
                   jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11};

// "August 31 2026" | "8/31/2026" | "2026-08-31"
function hbDate(str) {
  const t = String(str || '').trim();
  if (!t || t === '-') return null;
  let m = t.match(/^([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})$/);
  if (m && HB_MONTHS[m[1].toLowerCase()] != null) return { y:+m[3], mo:HB_MONTHS[m[1].toLowerCase()], d:+m[2] };
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { y:+m[3], mo:+m[1]-1, d:+m[2] };
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y:+m[1], mo:+m[2]-1, d:+m[3] };
  return null;
}

// "8:07am" | "8:07 AM" | "16:12"
function hbMinutes(str) {
  const t = String(str || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t || t === '-') return null;
  let m = t.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (m) {
    let h = +m[1];
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h * 60 + (+m[2]);
  }
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return (+m[1]) * 60 + (+m[2]);
  return null;
}

function mkTs(dt, mins) {
  // Local wall-clock time as recorded by the time clock.
  const d = new Date(dt.y, dt.mo, dt.d, Math.floor(mins/60), mins % 60, 0);
  return d;
}

// Parse the Homebase CSV export into shift rows.
function parseHomebaseCsv(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [], warnings = [];
  let cols = null;

  const idx = (name) => {
    if (!cols) return -1;
    const want = name.toLowerCase();
    return cols.findIndex(c => c.toLowerCase() === want);
  };

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    const f = splitCsvLine(raw);
    const first = (f[0] || '').trim();

    // repeated header block before each employee
    if (/^name$/i.test(first) && f.some(x => /clock in/i.test(x))) { cols = f; continue; }
    if (!cols) continue;
    if (!first || first === '-' || /^totals/i.test(first) || /^payroll period/i.test(first)) continue;

    const ciD = hbDate(f[idx('Clock in date')]);
    const ciT = hbMinutes(f[idx('Clock in time')]);
    const coD = hbDate(f[idx('Clock out date')]);
    const coT = hbMinutes(f[idx('Clock out time')]);
    // employee heading rows have a name but no punch — skip quietly
    if (!ciD || ciT == null || !coD || coT == null) continue;

    const inTs = mkTs(ciD, ciT);
    let outTs = mkTs(coD, coT);
    if (outTs <= inTs) { outTs = new Date(outTs.getTime() + 24*3600*1000); } // crossed midnight

    const num = (v) => { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
    const brk = num(f[idx('Break length')]) || 0;

    rows.push({
      homebase_name: first,
      work_date: `${ciD.y}-${String(ciD.mo+1).padStart(2,'0')}-${String(ciD.d).padStart(2,'0')}`,
      clock_in: inTs, clock_out: outTs,
      break_minutes: Math.round(brk > 12 ? brk : brk * 60), // minutes or decimal hours
      wage: num(f[idx('Wage rate')]),
      actual_hours: num(f[idx('Actual hours')]),
      paid_hours: num(f[idx('Total paid hours')]),
      ot_hours: num(f[idx('OT hours')])
    });
  }
  if (!cols) warnings.push('No Homebase header row found — is this the timesheets CSV export?');
  return { rows, warnings };
}

// ---- Employees ----
app.get('/api/employees', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.*,
            (SELECT COUNT(*)::int FROM inv_timecards t WHERE t.employee_id=e.id) AS shifts,
            (SELECT ROUND(SUM(t.actual_hours)::numeric,2) FROM inv_timecards t WHERE t.employee_id=e.id) AS total_hours
     FROM inv_employees e ORDER BY e.active DESC, e.display_name`);
  res.json(rows);
});

app.post('/api/employees', ownerAuth, async (req, res) => {
  const { id, display_name, homebase_name, wage, active } = req.body || {};
  if (id) {
    await pool.query(
      `UPDATE inv_employees SET display_name=COALESCE($2,display_name),
         homebase_name=COALESCE($3,homebase_name), wage=COALESCE($4,wage),
         active=COALESCE($5,active) WHERE id=$1`,
      [id, display_name || null, homebase_name || null, wage != null ? wage : null,
       typeof active === 'boolean' ? active : null]);
    return res.json({ ok: true, id });
  }
  if (!display_name) return res.status(400).json({ error: 'display_name required' });
  const r = await pool.query(
    `INSERT INTO inv_employees(display_name, homebase_name, wage) VALUES($1,$2,$3)
     ON CONFLICT (display_name) DO UPDATE SET homebase_name=EXCLUDED.homebase_name, wage=EXCLUDED.wage
     RETURNING id`, [display_name, homebase_name || null, wage != null ? wage : null]);
  res.json({ ok: true, id: r.rows[0].id });
});

// ---- Timesheet import ----
// dryRun previews the match before anything is written.
app.post('/api/timesheets/import', ownerAuth, async (req, res) => {
  const text = (req.body && req.body.text) || '';
  const dryRun = !!(req.body && req.body.dryRun);
  if (!text.trim()) return res.status(400).json({ error: 'Paste or upload the Homebase CSV first.' });

  const { rows, warnings } = parseHomebaseCsv(text);
  if (!rows.length) {
    return res.status(400).json({ error: 'No shifts found in that file.', warnings });
  }

  const emps = await pool.query('SELECT id, display_name, homebase_name FROM inv_employees');
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
  const byHb = {};
  for (const e of emps.rows) {
    if (e.homebase_name) byHb[norm(e.homebase_name)] = e;
    byHb[norm(e.display_name)] = byHb[norm(e.display_name)] || e;
  }
  // also match on first name, since display names are short
  const byFirst = {};
  for (const e of emps.rows) {
    const f = norm((e.homebase_name || e.display_name).split(/\s+/)[0]);
    if (f && !byFirst[f]) byFirst[f] = e;
  }

  const matched = [], unmatched = {};
  for (const r of rows) {
    const k = norm(r.homebase_name);
    const e = byHb[k] || byFirst[norm(r.homebase_name.split(/\s+/)[0])] || null;
    if (e) matched.push({ ...r, employee_id: e.id, display_name: e.display_name });
    else (unmatched[r.homebase_name] = unmatched[r.homebase_name] || []).push(r);
  }

  const summary = {};
  for (const m of matched) {
    const s2 = summary[m.display_name] = summary[m.display_name] || { shifts:0, hours:0, wage:m.wage, cost:0 };
    s2.shifts++;
    s2.hours += (m.actual_hours || 0);
    s2.cost  += (m.actual_hours || 0) * (m.wage || 0);
  }

  if (dryRun) {
    return res.json({ ok: true, dryRun: true, shifts: rows.length, matchedCount: matched.length,
      unmatched: Object.keys(unmatched).map(n => ({ name: n, shifts: unmatched[n].length })),
      summary, warnings });
  }

  let inserted = 0, updated = 0;
  for (const m of matched) {
    const r2 = await pool.query(
      `INSERT INTO inv_timecards(employee_id, homebase_name, work_date, clock_in, clock_out,
                                 break_minutes, wage, actual_hours, paid_hours, ot_hours)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (employee_id, clock_in) DO UPDATE SET
         clock_out=$5, break_minutes=$6, wage=$7, actual_hours=$8, paid_hours=$9, ot_hours=$10
       RETURNING (xmax = 0) AS was_insert`,
      [m.employee_id, m.homebase_name, m.work_date, m.clock_in, m.clock_out,
       m.break_minutes, m.wage, m.actual_hours, m.paid_hours, m.ot_hours]);
    if (r2.rows[0] && r2.rows[0].was_insert) inserted++; else updated++;
    // keep the employee's current wage in step with the latest punch
    if (m.wage) await pool.query('UPDATE inv_employees SET wage=$1 WHERE id=$2', [m.wage, m.employee_id]);
  }

  console.log(`[Timesheets] ${inserted} new, ${updated} updated, ${Object.keys(unmatched).length} unmatched names.`);
  res.json({ ok: true, shifts: rows.length, inserted, updated,
    unmatched: Object.keys(unmatched).map(n => ({ name: n, shifts: unmatched[n].length })),
    summary, warnings });
});

// What punches do we hold, and for when?
app.get('/api/timesheets/coverage', ownerAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.display_name, COUNT(t.id)::int AS shifts,
            MIN(t.work_date) AS first_day, MAX(t.work_date) AS last_day,
            ROUND(COALESCE(SUM(t.actual_hours),0)::numeric,2) AS hours,
            ROUND(COALESCE(SUM(t.actual_hours * t.wage),0)::numeric,2) AS cost,
            MAX(t.wage) AS wage
     FROM inv_employees e LEFT JOIN inv_timecards t ON t.employee_id=e.id
     WHERE e.active GROUP BY e.display_name ORDER BY e.display_name`);
  res.json(rows);
});

// ============================================================
// LANDED COST PER UNIT
// One calculation, four inputs. Any that are not yet tracked return null and
// are reported as MISSING rather than silently treated as zero — a blank line
// you can see beats a confident number that is quietly incomplete.
// ============================================================
async function buildLandedCosts() {
  // 1. product cost — blended across purchase lots
  const prods = await pool.query('SELECT asin, name, image, avg_cost, regular_cost FROM inv_products');
  const out = {};
  for (const p of prods.rows) {
    out[p.asin] = {
      asin: p.asin, name: p.name, image: p.image,
      productCost: p.avg_cost != null ? Number(p.avg_cost) : null,
      regularCost: p.regular_cost != null ? Number(p.regular_cost) : null,
      labor: null, supplies: null, inbound: null
    };
  }

  // 2. inbound — freight + placement, spread across the units in each shipment
  //    then averaged per ASIN weighted by how many units it shipped.
  try {
    const ships = await pool.query(`
      SELECT s.shipment_id,
             COALESCE((SELECT SUM(qty) FROM inv_shipment_items i WHERE i.shipment_id=s.shipment_id),0)::int AS units,
             COALESCE((SELECT SUM(amount) FROM inv_shipment_costs c WHERE c.shipment_id=s.shipment_id),0)::numeric AS cost
      FROM inv_shipments s`);
    const perShipUnit = {};
    for (const r of ships.rows) {
      if (r.units > 0 && Number(r.cost) > 0) perShipUnit[r.shipment_id] = Number(r.cost) / r.units;
    }
    const items = await pool.query('SELECT shipment_id, asin, qty FROM inv_shipment_items WHERE asin IS NOT NULL');
    const acc = {};
    for (const it of items.rows) {
      const per = perShipUnit[it.shipment_id];
      if (per == null || !it.qty) continue;
      const a = acc[it.asin] = acc[it.asin] || { units: 0, cost: 0 };
      a.units += it.qty; a.cost += per * it.qty;
    }
    for (const asin of Object.keys(acc)) {
      if (!out[asin]) continue;
      out[asin].inbound = acc[asin].units ? acc[asin].cost / acc[asin].units : null;
      out[asin].inboundUnits = acc[asin].units;
    }
  } catch (e) { console.error('[Landed] inbound allocation failed:', e.message); }

  // 3. labor — per unit from finished prep jobs, once crew time is attributed.
  //    Not wired yet: needs timecard clamping, so it stays null on purpose.

  // 4. supplies — per-unit recipe by size. Not collected yet.

  for (const k of Object.keys(out)) {
    const o = out[k];
    const parts = [o.productCost, o.labor, o.supplies, o.inbound];
    o.landed = parts.reduce((n, x) => n + (x || 0), 0);
    o.missing = [];
    if (o.productCost == null) o.missing.push('product cost');
    if (o.labor == null) o.missing.push('labor');
    if (o.supplies == null) o.missing.push('supplies');
    if (o.inbound == null) o.missing.push('inbound');
    o.complete = o.missing.length === 0;
  }
  return out;
}

app.get('/api/landed-costs', ownerAuth, async (req, res) => {
  try { res.json({ items: Object.values(await buildLandedCosts()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// MONTHLY P&L
// Revenue and Amazon fees come from settlements (real money). COGS is matched:
// units SOLD in the month times blended cost, so a twice-yearly buy does not
// wreck one month. Lines with no data yet are returned as null and shown blank.
// ============================================================
app.get('/api/pnl', ownerAuth, async (req, res) => {
  const month = String(req.query.month || '').match(/^\d{4}-\d{2}$/) ? req.query.month : null;
  const from = month ? `${month}-01` : (req.query.from || null);
  const to = month
    ? new Date(new Date(`${month}-01T00:00:00Z`).getTime() + 32 * 86400000).toISOString().slice(0, 8) + '01'
    : (req.query.to || null);

  const params = [], where = [];
  if (from) { params.push(from); where.push(`posted_date >= $${params.length}`); }
  if (to)   { params.push(to);   where.push(`posted_date < $${params.length}`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const lines = await pool.query(
    `SELECT asin, sku, amount_type, amount_description, transaction_type,
            SUM(amount)::numeric AS total, SUM(quantity)::int AS units
     FROM inv_settlement_lines ${clause}
     GROUP BY asin, sku, amount_type, amount_description, transaction_type`, params);

  const isRefund = t => /refund/i.test(t || '');
  let revenue = 0, refunds = 0, fees = 0, refundFees = 0, inboundFees = 0, otherFees = 0;
  const unitsByAsin = {};
  const feeDetail = {};

  for (const r of lines.rows) {
    const amt = Number(r.total) || 0;
    const desc = r.amount_description || 'Other';
    if (r.amount_type === 'ItemPrice' && !isRefund(r.transaction_type)) {
      revenue += amt;
      if (r.asin) unitsByAsin[r.asin] = (unitsByAsin[r.asin] || 0) + (r.units || 0);
    } else if (r.amount_type === 'ItemPrice') {
      refunds += amt;
      if (r.asin) unitsByAsin[r.asin] = (unitsByAsin[r.asin] || 0) + (r.units || 0);  // negative
    } else if (r.amount_type === 'ItemFees' && !isRefund(r.transaction_type)) {
      fees += amt; feeDetail[desc] = (feeDetail[desc] || 0) + amt;
    } else if (r.amount_type === 'ItemFees') {
      refundFees += amt; feeDetail[desc] = (feeDetail[desc] || 0) + amt;
    } else if (INBOUND_FEE_PATTERNS.test(desc)) {
      inboundFees += amt; feeDetail[desc] = (feeDetail[desc] || 0) + amt;
    } else {
      otherFees += amt; feeDetail[desc] = (feeDetail[desc] || 0) + amt;
    }
  }

  // matched COGS — cost of what actually SOLD this month
  const landed = await buildLandedCosts();
  let cogs = 0, inboundAllocated = 0, cogsMissing = [];
  let unitsSold = 0;
  for (const asin of Object.keys(unitsByAsin)) {
    const u = unitsByAsin[asin];
    if (u <= 0) continue;
    unitsSold += u;
    const l = landed[asin];
    if (!l || l.productCost == null) { cogsMissing.push(asin); continue; }
    cogs += l.productCost * u;
    if (l.inbound != null) inboundAllocated += l.inbound * u;
  }

  const netSales = revenue + refunds;
  const amazonFees = fees + refundFees + otherFees;      // negative
  const deposited = netSales + amazonFees + inboundFees;

  // labor and supplies: deliberately null until their data exists
  const labor = null, supplies = null, overhead = null;

  const netProfit = deposited - cogs - inboundAllocated
                    - (labor || 0) - (supplies || 0) - (overhead || 0);

  // What inbound cost has been CAPTURED, regardless of whether anything has
  // sold yet. Capture and allocation are different states: money recorded
  // against a shipment is not the same as money charged against a sale.
  let inboundCaptured = 0, inboundShipments = 0, inboundUnits = 0;
  try {
    const cap = await pool.query(`
      SELECT COALESCE(SUM(c.amount),0)::numeric AS total,
             COUNT(DISTINCT c.shipment_id)::int AS ships
      FROM inv_shipment_costs c`);
    inboundCaptured = Number(cap.rows[0].total) || 0;
    inboundShipments = cap.rows[0].ships || 0;
    const u = await pool.query(`
      SELECT COALESCE(SUM(i.qty),0)::int AS units FROM inv_shipment_items i
      WHERE i.shipment_id IN (SELECT DISTINCT shipment_id FROM inv_shipment_costs)`);
    inboundUnits = u.rows[0].units || 0;
  } catch (e) {}

  const coverage = await pool.query(
    'SELECT MIN(posted_date) AS first_day, MAX(posted_date) AS last_day, COUNT(DISTINCT settlement_id)::int AS settlements FROM inv_settlement_lines');

  res.json({
    month, from, to,
    revenue, refunds, netSales,
    amazonFees, feeDetail,
    inboundFeesFromSettlement: inboundFees,
    deposited,
    unitsSold,
    cogs: cogsMissing.length === Object.keys(unitsByAsin).length ? null : cogs,
    cogsMissingCount: cogsMissing.length,
    inboundAllocated: inboundAllocated || null,
    inboundCaptured, inboundShipments, inboundUnits,
    inboundPerUnitCaptured: inboundUnits ? inboundCaptured / inboundUnits : null,
    labor, supplies, overhead,
    netProfit,
    marginPct: netSales ? (netProfit / netSales) * 100 : null,
    hasSettlements: lines.rows.length > 0,
    coverage: coverage.rows[0]
  });
});

// ---- Inbound shipment costs ----
// Fee kinds Amazon uses for inbound charges, so settlement rows can be spotted.
const INBOUND_FEE_PATTERNS = /inbound|placement|transportation|partnered.?carrier|convenience/i;

// Enter (or correct) what a shipment cost. Manual entries are ESTIMATES and are
// replaced automatically once the settlement reports the real figure.
app.post('/api/shipment-costs/set', ownerAuth, async (req, res) => {
  const { shipment_id, kind, amount, note } = req.body || {};
  if (!shipment_id || !kind) return res.status(400).json({ error: 'shipment_id + kind required' });
  if (amount === '' || amount == null) {
    await pool.query("DELETE FROM inv_shipment_costs WHERE shipment_id=$1 AND kind=$2 AND source='estimate'", [shipment_id, kind]);
    return res.json({ ok: true, cleared: true });
  }
  const amt = Math.abs(parseFloat(amount));
  if (isNaN(amt)) return res.status(400).json({ error: 'amount must be a number' });
  // never let a manual figure overwrite one Amazon has already confirmed
  const cur = await pool.query('SELECT source FROM inv_shipment_costs WHERE shipment_id=$1 AND kind=$2', [shipment_id, kind]);
  if (cur.rows.length && cur.rows[0].source === 'actual') {
    return res.json({ ok: false, lockedByActual: true, message: 'Amazon has already billed this one — the settled amount stands.' });
  }
  await pool.query(
    `INSERT INTO inv_shipment_costs(shipment_id, kind, amount, entered_amount, source, note, updated_at)
     VALUES($1,$2,$3,$3,'entered',$4,now())
     ON CONFLICT (shipment_id, kind) DO UPDATE SET amount=$3, entered_amount=$3, source='entered', note=$4, variance=NULL, updated_at=now()`,
    [shipment_id, kind, amt, note || null]);
  res.json({ ok: true });
});

// Costs per shipment, with per-unit allocation.
app.get('/api/shipment-costs', ownerAuth, async (req, res) => {
  const ships = await pool.query(`
    SELECT s.shipment_id, s.shipment_name, s.status, s.created_at,
           COALESCE((SELECT SUM(qty) FROM inv_shipment_items i WHERE i.shipment_id=s.shipment_id),0)::int AS units
    FROM inv_shipments s ORDER BY s.created_at DESC LIMIT 100`);
  const costs = await pool.query('SELECT * FROM inv_shipment_costs');
  const byShip = {};
  for (const c of costs.rows) (byShip[c.shipment_id] = byShip[c.shipment_id] || []).push(c);

  const rows = ships.rows.map(s => {
    const list = byShip[s.shipment_id] || [];
    const total = list.reduce((n, c) => n + Number(c.amount), 0);
    const anyEstimate = list.some(c => c.source === 'estimate');
    return {
      ...s, costs: list, totalCost: total,
      perUnit: s.units ? total / s.units : null,
      confidence: !list.length ? 'none' : (anyEstimate ? 'estimate' : 'actual')
    };
  });
  const unlinked = await pool.query(
    'SELECT * FROM inv_unlinked_fees WHERE linked_shipment_id IS NULL ORDER BY posted_date DESC LIMIT 50');
  res.json({ rows, unlinked: unlinked.rows });
});

// Attach a settlement fee Amazon did not label with a shipment id.
app.post('/api/shipment-costs/link', ownerAuth, async (req, res) => {
  const { fee_id, shipment_id, kind } = req.body || {};
  if (!fee_id || !shipment_id) return res.status(400).json({ error: 'fee_id + shipment_id required' });
  const f = await pool.query('SELECT * FROM inv_unlinked_fees WHERE id=$1', [fee_id]);
  if (!f.rows.length) return res.status(404).json({ error: 'fee not found' });
  const fee = f.rows[0];
  const k = kind || (/placement/i.test(fee.description || '') ? 'placement' : 'freight');
  await pool.query(
    `INSERT INTO inv_shipment_costs(shipment_id, kind, amount, source, settlement_id, note, updated_at)
     VALUES($1,$2,$3,'actual',$4,$5,now())
     ON CONFLICT (shipment_id, kind) DO UPDATE SET amount=$3, source='actual', settlement_id=$4, note=$5, updated_at=now()`,
    [shipment_id, k, Math.abs(Number(fee.amount)), fee.settlement_id, fee.description]);
  await pool.query('UPDATE inv_unlinked_fees SET linked_shipment_id=$1 WHERE id=$2', [shipment_id, fee_id]);
  res.json({ ok: true, kind: k });
});

// Owner override — always wins over Amazon's declaration.
app.post('/api/hazmat/set', auth, async (req, res) => {
  const { asin, hazmat } = req.body || {};
  if (!asin) return res.status(400).json({ error: 'asin required' });
  const v = (hazmat === null || hazmat === undefined || hazmat === '') ? null : !!hazmat;
  if (v === null) {
    await pool.query('DELETE FROM inv_hazmat WHERE asin=$1', [asin]);
  } else {
    await pool.query(
      `INSERT INTO inv_hazmat(asin, hazmat, source, detail, updated_at)
       VALUES($1,$2,'manual','set by owner',now())
       ON CONFLICT (asin) DO UPDATE SET hazmat=$2, source='manual', detail='set by owner', updated_at=now()`,
      [asin, v]);
  }
  // mirror onto the product row so the On Hand side stays in step
  await pool.query('UPDATE inv_products SET hazmat=$1, hazmat_source=$2, hazmat_detail=$3 WHERE asin=$4',
    [v, v === null ? null : 'manual', v === null ? null : 'set by owner', asin]);
  res.json({ ok: true, asin, hazmat: v });
});

// Background scan of Amazon's hazmat data. Never overwrites a manual call.
let hazJob = { running:false, done:false, error:null, progress:'', found:0, checked:0 };
app.post('/api/hazmat/scan', auth, async (req, res) => {
  if (hazJob.running) return res.json({ ok:true, already:true });
  hazJob = { running:true, done:false, error:null, progress:'starting…', found:0, checked:0 };
  res.json({ ok:true });
  (async () => {
    try {
      // every ASIN we track, not just the ones we stock
      let tracked = [];
      try { tracked = JSON.parse(fs.readFileSync(path.join(__dirname, 'keepa_asins.json'), 'utf8')); } catch(e) {}
      const owned = await pool.query('SELECT asin FROM inv_products');
      const manual = await pool.query("SELECT asin FROM inv_hazmat WHERE source='manual'");
      const skip = new Set(manual.rows.map(x=>x.asin));
      const all = [...new Set([...tracked, ...owned.rows.map(x=>x.asin)])].filter(a => a && !skip.has(a));
      hazJob.progress = `checking ${all.length} ASINs…`;
      const r = await getHazmatStatus(all, p => { hazJob.progress = p; });
      for (const asin of Object.keys(r)) {
        const h = r[asin];
        if (h.hazmat === null) continue;
        await pool.query(
          `INSERT INTO inv_hazmat(asin, hazmat, source, detail, updated_at)
           VALUES($1,$2,$3,$4,now())
           ON CONFLICT (asin) DO UPDATE SET hazmat=$2, source=$3, detail=$4, updated_at=now()
           WHERE inv_hazmat.source IS DISTINCT FROM 'manual'`,
          [asin, h.hazmat, h.source, h.detail]);
        await pool.query(
          "UPDATE inv_products SET hazmat=$1, hazmat_source=$2, hazmat_detail=$3 WHERE asin=$4 AND hazmat_source IS DISTINCT FROM 'manual'",
          [h.hazmat, h.source, h.detail, asin]);
        hazJob.checked++;
        if (h.hazmat) hazJob.found++;
      }
      hazJob.progress = `${hazJob.checked} resolved, ${hazJob.found} flagged hazmat.`;
      hazJob.running = false; hazJob.done = true;
      console.log(`[Hazmat] ${hazJob.checked} resolved, ${hazJob.found} hazmat.`);
    } catch (e) { hazJob.running=false; hazJob.error=e.message; console.error('[Hazmat] scan failed:', e.message); }
  })();
});
app.get('/api/hazmat/status', auth, (req,res)=>res.json(hazJob));

// Age + size of every cached data set, for the freshness bar.
app.get('/api/cache-status', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT cache_key, updated_at, data FROM inv_cache');
  const out = {};
  for (const r of rows) {
    let n = 0;
    try { n = Array.isArray(r.data) ? r.data.length : (r.data && r.data.items ? r.data.items.length : 0); } catch(e) {}
    out[r.cache_key] = { updated_at: r.updated_at, count: n };
  }
  res.json(out);
});

// Break a bad link so the number shows as unmapped again and can be re-picked.
app.post('/api/cosmo-map/unlink', auth, async (req, res) => {
  const { cosmo_num } = req.body || {};
  if (!cosmo_num) return res.status(400).json({ error: 'cosmo_num required' });
  await pool.query('DELETE FROM inv_cosmo_map WHERE cosmo_num=$1', [cosmo_num]);
  await pool.query(
    `UPDATE inv_invoice_items SET asin=NULL WHERE cosmo_num=$1
     AND order_number IN (SELECT order_number FROM inv_invoices WHERE status <> 'received')`,
    [cosmo_num]);
  console.log(`[Verify] Cosmo# ${cosmo_num} UNLINKED.`);
  res.json({ ok: true });
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
  // A human pick is a SUGGESTION, not proof — it stays unverified until a
  // barcode scan confirms it.
  await pool.query(
    `INSERT INTO inv_cosmo_map(cosmo_num, asin, verified, source) VALUES($1,$2,false,'picked')
     ON CONFLICT (cosmo_num) DO UPDATE SET asin=$2, verified=false, verified_at=NULL, verified_upc=NULL, source='picked'`,
    [cosmo_num, asin]);
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
// Set every line's received qty to the expected qty (clean truck, no exceptions).
app.post('/api/invoices/:orderNumber/receive-all', auth, async (req, res) => {
  const order = req.params.orderNumber;
  const r = await pool.query(
    'UPDATE inv_invoice_items SET qty_received = qty_expected WHERE order_number=$1 AND asin IS NOT NULL RETURNING id',
    [order]);
  res.json({ ok: true, lines: r.rowCount });
});

// Complete a check-in.
//   dryRun: true  -> PRACTICE. Computes and returns the full preview, writes
//                    NOTHING to stock, activity, locations, or invoice status.
//   force:  true  -> proceed even though some lines are still unmapped
//                    (those units are discarded — the UI must say so).
// Without force, unmapped lines hard-stop with 409 so nothing is silently lost.
app.post('/api/invoices/:orderNumber/complete', auth, async (req, res) => {
  const order = req.params.orderNumber;
  const dryRun = !!(req.body && req.body.dryRun);
  const force  = !!(req.body && req.body.force);
  // skipStock: the goods were physically received and counted into On Hand at
  // some earlier point (before this invoice was loaded, or by a manual count).
  // Record everything EXCEPT the stock increment, so quantities are not
  // double-added. Cost lots, locations and the received stamp still happen.
  const skipStock = !!(req.body && req.body.skipStock);

  const lines = await pool.query(
    'SELECT asin, cosmo_num, description, qty_expected, qty_received, unit_cost FROM inv_invoice_items WHERE order_number=$1',
    [order]);
  const invMeta = await pool.query('SELECT invoice_date FROM inv_invoices WHERE order_number=$1', [order]);
  const invDate = invMeta.rows[0] ? invMeta.rows[0].invoice_date : null;

  // ---- HARD STOP: never silently drop unmapped lines ----
  const unmapped = lines.rows.filter(l => !l.asin);
  if (unmapped.length && !force) {
    return res.status(409).json({
      ok: false,
      error: 'unmapped_lines',
      unmapped: unmapped.map(l => ({
        cosmo_num: l.cosmo_num,
        description: l.description,
        qty_expected: l.qty_expected,
        qty_received: l.qty_received
      })),
      unmappedUnits: unmapped.reduce((n, l) => n + (l.qty_received || l.qty_expected || 0), 0)
    });
  }

  let added = 0;
  const discrepancies = [];
  const preview = [];

  // Pallet locations picked during check-in: { asin: 'A-1', ... }
  const locs = (req.body && req.body.locations) || {};
  let locSet = 0;
  for (const [asin, raw] of Object.entries(locs)) {
    const loc = normLoc(raw);
    if (!loc) continue;
    if (!dryRun) {
      try {
        await pool.query('UPDATE inv_products SET location=$1 WHERE asin=$2', [loc, asin]);
      } catch (e) { console.error('[Location] set failed for', asin, e.message); continue; }
    }
    locSet++;
  }
  if (locSet && !dryRun) console.log(`[Location] Set ${locSet} pallet locations from invoice ${order}.`);

  for (const l of lines.rows) {
    if (!l.asin) {
      preview.push({ description: l.description, cosmo_num: l.cosmo_num, asin: null,
                     qty: l.qty_received, expected: l.qty_expected, willAdd: false, reason: 'unmapped — DISCARDED' });
      continue;
    }
    if (l.qty_received > 0) {
      if (!dryRun) {
        if (!skipStock) {
          await pool.query('UPDATE inv_stock SET onhand = onhand + $1 WHERE asin=$2', [l.qty_received, l.asin]);
          await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) SELECT $1,$2,name,$3,$4 FROM inv_products WHERE asin=$2',
            ['in', l.asin, l.qty_received, 'Received invoice ' + order]);
        } else {
          // audit trail only — zero quantity so no count moves
          await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) SELECT $1,$2,name,$3,$4 FROM inv_products WHERE asin=$2',
            ['in', l.asin, 0, 'Invoice ' + order + ' recorded — stock NOT added (already counted)']);
        }
      }
      added += l.qty_received;
      // Record the purchase lot: what was paid, when, how many. Sale pricing is
      // preserved rather than overwriting the regular cost.
      if (!dryRun && l.unit_cost != null && l.qty_received > 0) {
        try {
          await pool.query(
            `INSERT INTO inv_cost_history(asin, order_number, invoice_date, unit_cost, qty)
             VALUES($1,$2,$3,$4,$5)
             ON CONFLICT (order_number, asin) DO UPDATE SET unit_cost=$4, qty=$5, invoice_date=$3`,
            [l.asin, order, invDate, l.unit_cost, l.qty_received]);
        } catch (e) { console.error('[Costs] lot insert failed:', e.message); }
      }
      preview.push({ description: l.description, asin: l.asin, qty: l.qty_received,
                     expected: l.qty_expected, location: locs[l.asin] || null,
                     unitCost: l.unit_cost != null ? Number(l.unit_cost) : null,
                     willAdd: !skipStock,
                     reason: skipStock ? 'cost + location recorded, stock unchanged' : undefined });
    } else {
      preview.push({ description: l.description, asin: l.asin, qty: 0,
                     expected: l.qty_expected, willAdd: false, reason: 'nothing received' });
    }
    if (l.qty_received !== l.qty_expected) {
      discrepancies.push({ description: l.description, expected: l.qty_expected, received: l.qty_received });
    }
  }

  if (!dryRun) {
    await pool.query("UPDATE inv_invoices SET status='received', completed_at=now() WHERE order_number=$1", [order]);
    try { await recomputeCosts(); } catch (e) { console.error('[Costs] reblend failed (non-fatal):', e.message); }
  }

  if (skipStock && !dryRun) console.log(`[Invoice] ${order} recorded WITHOUT adding ${added} units (already on hand).`);

  res.json({
    ok: true, dryRun, skipStock, added, discrepancies, preview,
    locationsSet: locSet,
    unmappedCount: unmapped.length,
    lineCount: lines.rows.length
  });
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

// Pull product images from Amazon (SP-API Catalog) for products missing them
app.post('/api/pull-images', auth, async (req, res) => {
  const onlyMissing = req.body.onlyMissing !== false; // default: only missing
  const q = onlyMissing
    ? "SELECT asin FROM inv_products WHERE (image IS NULL OR image='') AND asin IS NOT NULL"
    : "SELECT asin FROM inv_products WHERE asin IS NOT NULL";
  const prods = await pool.query(q);
  const asins = prods.rows.map(r => r.asin);
  if (!asins.length) return res.json({ ok: true, saved: 0, message: 'No products need images.' });

  let images;
  try { images = await getCatalogImages(asins); }
  catch(err){ return res.status(400).json({ error: err.message }); }

  let saved = 0;
  for (const asin in images) {
    try { const r = await pool.query('UPDATE inv_products SET image=$1 WHERE asin=$2', [images[asin], asin]); if(r.rowCount) saved++; } catch(e){}
  }
  console.log(`[Images] Pulled ${saved} of ${asins.length} from Amazon Catalog`);
  res.json({ ok: true, saved, requested: asins.length });
});

// Reconcile a shipment against its plan TSV: add ONLY the missing units (no double-deduct)
app.post('/api/reconcile-shipment', auth, upload.single('file'), async (req, res) => {
  let text = req.file ? req.file.buffer.toString('utf-8') : (req.body.text||'');
  const lines = text.split(/\r?\n/);
  let shipmentId = '';
  for (const l of lines.slice(0,8)) { const c=l.split('\t'); if(/^Shipment ID/i.test(c[0])) shipmentId=(c[1]||'').trim(); }
  let hdrIdx=-1, cols=[];
  for (let i=0;i<lines.length;i++){ if(/Merchant SKU/i.test(lines[i])&&/FNSKU/i.test(lines[i])){hdrIdx=i;cols=lines[i].split('\t').map(c=>c.trim());break;} }
  if(hdrIdx===-1||!shipmentId) return res.status(400).json({error:'Bad shipment plan file'});
  const asinIdx=cols.findIndex(c=>/^ASIN/i.test(c)), skuIdx=cols.findIndex(c=>/Merchant SKU/i.test(c)), fnIdx=cols.findIndex(c=>/FNSKU/i.test(c)), qtyIdx=cols.findIndex(c=>/Shipped/i.test(c));

  // Build EXPECTED component-level quantities from the plan (expanding duos)
  const expected = {}; // asin -> qty
  const preview = { isPreview: req.body.preview==='true'||req.body.preview===true };
  for (let i=hdrIdx+1;i<lines.length;i++){
    const c=lines[i].split('\t'); if(c.length<=qtyIdx) continue;
    const asin=(c[asinIdx]||'').trim(), sku=(c[skuIdx]||'').trim(), fnsku=(c[fnIdx]||'').trim();
    const qty=parseInt(c[qtyIdx])||0; if(qty<1) continue;
    const r=await pool.query('SELECT asin FROM inv_products WHERE UPPER(asin)=UPPER($1) OR UPPER(fnsku)=UPPER($2) OR UPPER(sku)=UPPER($3) LIMIT 1',[asin,fnsku,sku]);
    if(!r.rows.length) continue;
    const parts=await expandToComponents(r.rows[0].asin, qty);
    for(const p of parts) expected[p.asin]=(expected[p.asin]||0)+p.qty;
  }

  // What's ALREADY recorded in this shipment
  const recorded={};
  const rec=await pool.query('SELECT asin, SUM(qty) AS q FROM inv_shipment_items WHERE shipment_id=$1 GROUP BY asin',[shipmentId]);
  for(const r of rec.rows) recorded[r.asin]=parseInt(r.q);

  // The GAP = expected - recorded (only positive gaps need adding)
  const gaps=[];
  for(const asin in expected){
    const need=expected[asin]-(recorded[asin]||0);
    if(need>0){
      const nm=await pool.query('SELECT name FROM inv_products WHERE asin=$1',[asin]);
      gaps.push({asin, name:nm.rows[0]?.name||asin, missing:need, expected:expected[asin], recorded:recorded[asin]||0});
    }
  }

  if(preview.isPreview){
    return res.json({ok:true, preview:true, shipmentId, gaps});
  }

  // Apply the gaps: deduct from on-hand, add to shipment + transit
  let added=0;
  for(const g of gaps){
    await pool.query('UPDATE inv_stock SET onhand=onhand-$1, transit=transit+$1 WHERE asin=$2',[g.missing,g.asin]);
    await pool.query('INSERT INTO inv_shipment_items(shipment_id,asin,qty) VALUES($1,$2,$3)',[shipmentId,g.asin,g.missing]);
    await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',['out',g.asin,g.name,g.missing,'Reconcile '+shipmentId]);
    await pool.query('UPDATE inv_prepped SET qty=GREATEST(0,qty-$1) WHERE asin=$2',[g.missing,g.asin]);
    added+=g.missing;
  }
  await pool.query('DELETE FROM inv_prepped WHERE qty<=0');
  res.json({ok:true, shipmentId, gapsFixed:gaps.length, unitsAdded:added, gaps});
});

// Full bundle dump — every bundle with its components (to spot bad mappings)
app.get('/api/all-bundles-detail', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT b.bundle_asin, bp.name AS bundle_name,
           b.component_asin, cp.name AS comp_name
    FROM inv_bundles b
    JOIN inv_products bp ON bp.asin=b.bundle_asin
    JOIN inv_products cp ON cp.asin=b.component_asin
    ORDER BY bp.name, cp.name`);
  const map={};
  for(const x of r.rows){
    if(!map[x.bundle_asin]) map[x.bundle_asin]={bundle_asin:x.bundle_asin,bundle_name:x.bundle_name,components:[]};
    map[x.bundle_asin].components.push({asin:x.component_asin,name:x.comp_name});
  }
  res.json(Object.values(map));
});

// Diagnostic: check bundle definitions for specific ASINs
app.get('/api/check-bundles', auth, async (req, res) => {
  const asins = (req.query.asins||'').split(',').map(a=>a.trim()).filter(Boolean);
  const out = [];
  for (const a of asins) {
    const b = await pool.query('SELECT b.component_asin, p.name FROM inv_bundles b JOIN inv_products p ON p.asin=b.component_asin WHERE b.bundle_asin=$1', [a]);
    const prod = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [a]);
    out.push({ asin:a, name:prod.rows[0]?.name||'(not in catalog)', isBundle:b.rows.length>0, components:b.rows.map(r=>r.name) });
  }
  res.json(out);
});

// Ship to FBA via Amazon shipment plan TSV upload — parses SKU/ASIN/FNSKU + Shipped qty
app.post('/api/ship-from-tsv', auth, upload.single('file'), async (req, res) => {
  let text;
  if (req.file) text = req.file.buffer.toString('utf-8');
  else if (req.body.text) text = req.body.text;
  else return res.status(400).json({ error: 'No file or text provided' });

  const lines = text.split(/\r?\n/);
  // pull shipment id + name from the header block
  let shipmentId = '', shipmentName = '';
  for (const l of lines.slice(0, 8)) {
    const c = l.split('\t');
    if (/^Shipment ID/i.test(c[0])) shipmentId = (c[1]||'').trim();
    if (/^Name/i.test(c[0])) shipmentName = (c[1]||'').trim();
  }
  // find the data header row (has Merchant SKU + FNSKU + Shipped)
  let hdrIdx = -1, cols = [];
  for (let i=0;i<lines.length;i++){
    if (/Merchant SKU/i.test(lines[i]) && /FNSKU/i.test(lines[i])) { hdrIdx=i; cols=lines[i].split('\t').map(c=>c.trim()); break; }
  }
  if (hdrIdx === -1) return res.status(400).json({ error: 'Not an Amazon shipment plan (no Merchant SKU/FNSKU header found).' });
  if (!shipmentId) return res.status(400).json({ error: 'No Shipment ID found in the file.' });

  const skuIdx = cols.findIndex(c=>/Merchant SKU/i.test(c));
  const asinIdx = cols.findIndex(c=>/^ASIN/i.test(c));
  const fnIdx = cols.findIndex(c=>/FNSKU/i.test(c));
  const qtyIdx = cols.findIndex(c=>/Shipped/i.test(c));
  if (qtyIdx === -1) return res.status(400).json({ error: 'No "Shipped" quantity column found.' });

  // build the item list
  const items = [];
  for (let i=hdrIdx+1;i<lines.length;i++){
    const c = lines[i].split('\t');
    if (c.length <= qtyIdx) continue;
    const asin = (c[asinIdx]||'').trim();
    const sku = (c[skuIdx]||'').trim();
    const fnsku = (c[fnIdx]||'').trim();
    const qty = parseInt(c[qtyIdx]) || 0;
    if (qty < 1) continue;
    items.push({ asin, sku, fnsku, qty });
  }
  if (!items.length) return res.status(400).json({ error: 'No line items with a shipped quantity.' });

  // register shipment
  await pool.query(
    `INSERT INTO inv_shipments(shipment_id, shipment_name) VALUES($1,$2)
     ON CONFLICT (shipment_id) DO UPDATE SET shipment_name = COALESCE(NULLIF($2,''), inv_shipments.shipment_name)`,
    [shipmentId, shipmentName]);

  const isPreview = req.body.preview === 'true' || req.body.preview === true;
  let done = 0, notfound = [], expandedNote = [], previewLines = [];
  for (const it of items) {
    // match by ASIN, then FNSKU, then SKU
    let r = await pool.query('SELECT asin, name FROM inv_products WHERE UPPER(asin)=UPPER($1) OR UPPER(fnsku)=UPPER($2) OR UPPER(sku)=UPPER($3) LIMIT 1', [it.asin, it.fnsku, it.sku]);
    if (!r.rows.length) { notfound.push(it.asin || it.sku || it.fnsku); continue; }
    const matchedAsin = r.rows[0].asin;
    const parts = await expandToComponents(matchedAsin, it.qty);
    // build preview line
    if (parts.length > 1 || parts[0].fromBundle) {
      previewLines.push(`${r.rows[0].name.slice(0,30)} (DUO ×${it.qty}) → ` + parts.map(p=>`${p.qty} ${p.name.slice(0,24)}`).join(' + '));
    } else {
      previewLines.push(`${r.rows[0].name.slice(0,40)} → deduct ${it.qty}`);
    }
    if (isPreview) { done++; continue; }  // preview: don't actually deduct
    for (const part of parts) {
      await pool.query('UPDATE inv_stock SET onhand = onhand - $1, transit = transit + $1 WHERE asin=$2', [part.qty, part.asin]);
      await pool.query('INSERT INTO inv_shipment_items(shipment_id, asin, qty) VALUES($1,$2,$3)', [shipmentId, part.asin, part.qty]);
      await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
        ['out', part.asin, part.name, part.qty, part.fromBundle ? ('Shipment '+shipmentId+' (duo)') : ('Shipment '+shipmentId)]);
      // clear ONLY this item from prepped
      await pool.query('UPDATE inv_prepped SET qty = GREATEST(0, qty - $1) WHERE asin=$2', [part.qty, part.asin]);
    }
    await pool.query('UPDATE inv_prepped SET qty = GREATEST(0, qty - $1) WHERE asin=$2', [it.qty, matchedAsin]);
    if (parts.length > 1 || parts[0].fromBundle) expandedNote.push(`${it.asin} → ${parts.length} singles`);
    done++;
  }
  if (isPreview) {
    return res.json({ ok: true, preview: true, shipmentId, shipmentName, done, notfound, previewLines, totalLines: items.length });
  }
  await pool.query('DELETE FROM inv_prepped WHERE qty <= 0');
  res.json({ ok: true, shipmentId, shipmentName, done, notfound, expanded: expandedNote, totalLines: items.length });
});

// PDF upload -> extract text -> process (multi-order)
// ============================================================
// PDF TEXT EXTRACTION (two readers, tried in order)
//   1. pdf-parse  — bundled, but ships a ~2018 pdf.js that rejects newer
//                   Cosmoprof PDFs (linearised + /Type/XRef + ObjStm).
//   2. pdfjs-dist — current pdf.js, loaded lazily. If the package is missing
//                   or throws, we fall through cleanly and report the failure.
// Never let reader #2 being absent break the endpoint.
// ============================================================
async function extractPdfText(buffer) {
  const tried = [];

  try {
    const data = await pdfParse(buffer);
    if (data && data.text && data.text.trim()) return { text: data.text, via: 'pdf-parse' };
    tried.push('pdf-parse: opened but produced no text');
  } catch (e) {
    tried.push('pdf-parse: ' + (e && e.message ? e.message : e));
  }

  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;

    let out = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // Cosmoprof invoices are column-laid-out, so rebuild physical lines by
      // Y position and order each line left-to-right by X.
      const rows = new Map();
      for (const it of content.items) {
        if (!it.str) continue;
        const y = Math.round(it.transform[5]);
        if (!rows.has(y)) rows.set(y, []);
        rows.get(y).push({ x: it.transform[4], s: it.str });
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) {
        const line = rows.get(y).sort((a, b) => a.x - b.x).map(t => t.s).join(' ').replace(/\s+/g, ' ').trim();
        if (line) out += line + '\n';
      }
      out += '\n';
    }
    if (out.trim()) return { text: out, via: 'pdfjs-dist' };
    tried.push('pdfjs-dist: opened but produced no text (likely a scan)');
  } catch (e) {
    tried.push('pdfjs-dist: ' + (e && e.message ? e.message : e));
  }

  return { text: '', via: null, tried };
}

app.post('/api/invoices/upload-pdf', auth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const extracted = await extractPdfText(req.file.buffer);
  const text = extracted.text;
  if (!text || !text.trim()) {
    console.error('[PDF] all readers failed:', (extracted.tried || []).join(' | '));
    return res.status(400).json({
      error: 'Neither PDF reader could get text out of this file. The invoice is probably fine — open it, select all the text (Ctrl+A), copy, and use the PASTE option instead.',
      pdfReaderFailed: true,
      tried: extracted.tried || []
    });
  }
  console.log(`[PDF] Text extracted via ${extracted.via} (${text.length} chars).`);
  if (!/FOR ORDER NUMBER:/i.test(text)) {
    return res.status(400).json({ error: 'No "FOR ORDER NUMBER:" found in PDF. It may be a different format — try the paste option.' });
  }
  const { created, errors } = await processInvoiceText(text);
  if (!created.length) return res.status(400).json({ error: 'Found order headers but no line items parsed. Try paste as backup.', errors, via: extracted.via });
  res.json({ ok: true, created, errors, via: extracted.via });
});

// ============================================================
// DATA / DASHBOARD ENDPOINTS
// ============================================================

// Dashboard summary — everything at a glance (uses data we already have)
// ============================================================
// STOCK AUDIT
// inv_stock.onhand is a running balance. If it looks wrong, the answer is in
// the movements that produced it — most often the same invoice received twice.
// ============================================================
app.get('/api/stock-audit', ownerAuth, async (req, res) => {
  // every ASIN holding stock, with what the activity log says should be there
  const { rows } = await pool.query(`
    SELECT s.asin, p.name, COALESCE(s.onhand,0)::int AS onhand, COALESCE(s.transit,0)::int AS transit,
      COALESCE((SELECT SUM(CASE WHEN a.direction='in' THEN a.qty ELSE -a.qty END)
                FROM inv_activity a WHERE a.asin = s.asin),0)::int AS net_movement,
      COALESCE((SELECT SUM(a.qty) FROM inv_activity a WHERE a.asin=s.asin AND a.direction='in'),0)::int AS total_in,
      COALESCE((SELECT SUM(a.qty) FROM inv_activity a WHERE a.asin=s.asin AND a.direction='out'),0)::int AS total_out
    FROM inv_stock s LEFT JOIN inv_products p ON p.asin = s.asin
    WHERE COALESCE(s.onhand,0) <> 0 OR COALESCE(s.transit,0) <> 0
    ORDER BY COALESCE(s.onhand,0) DESC`);

  // the same invoice booked into stock more than once
  const dupes = await pool.query(`
    SELECT note, asin, COUNT(*)::int AS times, SUM(qty)::int AS units,
           MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM inv_activity
    WHERE direction='in' AND note LIKE 'Received invoice %'
    GROUP BY note, asin HAVING COUNT(*) > 1
    ORDER BY SUM(qty) DESC`);

  // every receipt, newest first, so a repeat is easy to spot by eye
  const receipts = await pool.query(`
    SELECT note, COUNT(DISTINCT asin)::int AS skus, SUM(qty)::int AS units,
           MIN(ts) AS ts
    FROM inv_activity WHERE direction='in' AND note LIKE 'Received invoice %'
    GROUP BY note ORDER BY MIN(ts) DESC LIMIT 40`);

  // EVERY inbound movement, grouped by where it came from. Invoice check-ins are
  // only one source — manual receiving scans and hand edits also move stock, and
  // those are usually what an unexplained total turns out to be.
  const sources = await pool.query(`
    SELECT
      CASE
        WHEN note LIKE 'Received invoice %' THEN 'Invoice check-in'
        WHEN note IS NULL OR note = ''      THEN 'No note recorded'
        ELSE split_part(note, ' ', 1) || ' ' || COALESCE(split_part(note, ' ', 2), '')
      END AS source,
      COUNT(*)::int AS movements,
      SUM(qty)::int AS units,
      MIN(ts) AS first_ts, MAX(ts) AS last_ts
    FROM inv_activity WHERE direction='in'
    GROUP BY 1 ORDER BY SUM(qty) DESC`);

  // the raw inbound tail, so anything odd is visible directly
  const recentIn = await pool.query(`
    SELECT a.direction, a.asin, a.name, a.qty, a.note, a.ts
    FROM inv_activity a WHERE a.direction='in'
    ORDER BY a.ts DESC LIMIT 60`);

  const totalIn = await pool.query("SELECT COALESCE(SUM(qty),0)::int AS n FROM inv_activity WHERE direction='in'");
  const totalOut = await pool.query("SELECT COALESCE(SUM(qty),0)::int AS n FROM inv_activity WHERE direction='out'");

  // stock rows with no matching product record
  const orphans = await pool.query(`
    SELECT s.asin, COALESCE(s.onhand,0)::int AS onhand FROM inv_stock s
    LEFT JOIN inv_products p ON p.asin=s.asin
    WHERE p.asin IS NULL AND COALESCE(s.onhand,0) <> 0`);

  // stock sitting on a BUNDLE asin — duos are meant to live as components only
  const bundleStock = await pool.query(`
    SELECT s.asin, p.name, COALESCE(s.onhand,0)::int AS onhand FROM inv_stock s
    LEFT JOIN inv_products p ON p.asin=s.asin
    WHERE COALESCE(s.onhand,0) > 0
      AND s.asin IN (SELECT DISTINCT bundle_asin FROM inv_bundles)`);

  const totals = rows.reduce((a, r) => {
    a.onhand += r.onhand; a.transit += r.transit; a.net += r.net_movement; return a;
  }, { onhand:0, transit:0, net:0 });

  res.json({
    rows: rows.map(r => ({ ...r, drift: r.onhand - r.net_movement })),
    totals,
    sources: sources.rows,
    recentIn: recentIn.rows,
    movementTotals: { in: totalIn.rows[0].n, out: totalOut.rows[0].n },
    duplicates: dupes.rows,
    receipts: receipts.rows,
    orphans: orphans.rows,
    bundleStock: bundleStock.rows
  });
});

app.get('/api/dashboard', auth, async (req, res) => {
  const stock = await pool.query('SELECT COALESCE(SUM(onhand),0)::int AS onhand, COALESCE(SUM(transit),0)::int AS transit FROM inv_stock');
  // committed totals so the dashboard matches the On Hand page's "Available"
  const preppedTot = await pool.query(`
    SELECT (
      COALESCE((SELECT SUM(pr.qty) FROM inv_prepped pr WHERE pr.asin NOT IN (SELECT bundle_asin FROM inv_bundles)),0)
      + COALESCE((SELECT SUM(pr.qty*b.qty) FROM inv_prepped pr JOIN inv_bundles b ON b.bundle_asin=pr.asin),0)
    )::int AS n`);
  // per-ASIN committed map so lists can show AVAILABLE consistently
  const committedMap = await pool.query(`
    SELECT p.asin,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
      + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      + COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
      + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=p.asin),0)
      )::int AS committed
    FROM inv_products p`);
  const committedByAsin = {}; for (const r of committedMap.rows) committedByAsin[r.asin] = r.committed;
  // total units in PENDING PREP work orders (component-level: singles + duo components)
  const pendingPrep = await pool.query(`
    SELECT (
      COALESCE((SELECT SUM(pp.qty) FROM inv_pending_prep pp WHERE pp.is_duo = false),0)
      + COALESCE((SELECT SUM(pp.qty * b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin),0)
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
  const topStockRaw = await pool.query('SELECT p.asin, p.name, s.onhand FROM inv_stock s JOIN inv_products p ON p.asin=s.asin WHERE s.onhand>0');
  const topStock = { rows: topStockRaw.rows
      .map(r => ({ ...r, onhand: Math.max(0, r.onhand - (committedByAsin[r.asin]||0)) }))
      .filter(r => r.onhand > 0)
      .sort((a,b)=> b.onhand - a.onhand).slice(0,10) };
  // low stock list
  const lowListRaw = await pool.query('SELECT p.asin, p.name, s.onhand FROM inv_stock s JOIN inv_products p ON p.asin=s.asin');
  const lowList = { rows: lowListRaw.rows
      .map(r => ({ ...r, onhand: Math.max(0, r.onhand - (committedByAsin[r.asin]||0)) }))
      .filter(r => r.onhand > 0 && r.onhand <= 20)
      .sort((a,b)=> a.onhand - b.onhand).slice(0,10) };
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

  // Retail value: use CURRENT on-hand quantities × last-known Amazon prices.
  // (Quantities are always live; only the prices come from the cached pull.)
  let retailValue = null, retailAsOf = null, retailPricedCount = 0, retailTotalCount = 0;
  try {
    const rv = await pool.query("SELECT data, updated_at FROM inv_cache WHERE cache_key='inventory_value'");
    if (rv.rows.length) {
      const priceByAsin = {};
      for (const x of (rv.rows[0].data || [])) {
        if (x.amazon_price) priceByAsin[x.asin] = parseFloat(x.amazon_price);
      }
      const live = await pool.query('SELECT asin, onhand FROM inv_stock WHERE onhand > 0');
      retailTotalCount = live.rows.length;
      let v = 0;
      for (const r of live.rows) {
        const p = priceByAsin[r.asin];
        if (p) { v += p * r.onhand; retailPricedCount++; }
      }
      retailValue = Math.round(v);
      retailAsOf = rv.rows[0].updated_at;   // when the PRICES were pulled
    }
  } catch(e) { console.error('retail value calc failed:', e.message); }
  const totalOnhand = stock.rows[0].onhand;
  const totalPendingPrep = pendingPrep.rows[0].n;
  const totalPrepped = preppedTot.rows[0].n;
  const totalAvailable = Math.max(0, totalOnhand - totalPendingPrep - totalPrepped);
  res.json({
    onhand: totalAvailable,            // "Units On Hand" card now = AVAILABLE (matches On Hand page)
    totalOnhand, totalPendingPrep, totalPrepped, totalAvailable,
    transit: stock.rows[0].transit,
    skus: skus.rows[0].n, lowStock: lowStock.rows[0].n, outStock: outStock.rows[0].n,
    pendingInvoices: pendingInv.rows[0].n, pendingUnits: pendingUnits.rows[0].n, pendingPrep: pendingPrep.rows[0].n, openShipments: openShip.rows[0].n, todayActivity: todayAct.rows[0].n,
    recent: recent.rows, topStock: topStock.rows, lowList: lowList.rows, underStocked,
    retailValue, retailAsOf, retailPricedCount, retailTotalCount,
    mfnOpportunities: await (async()=>{
      try {
        const c = await pool.query("SELECT data, updated_at FROM inv_cache WHERE cache_key='mfn_opportunities'");
        if (!c.rows.length) return { items: [], updatedAt: null };
        return { items: (c.rows[0].data||[]).slice(0,15), updatedAt: c.rows[0].updated_at, total: (c.rows[0].data||[]).length };
      } catch(e) { return { items: [], updatedAt: null }; }
    })()
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

// PRODUCTS TO ADD — driven by LIVE KEEPA data (refreshes with Market Data).
// SmartScout units layered on where available for extra precision.
app.get('/api/products-to-add', ownerAuth, async (req, res) => {
  // primary source: cached Keepa market data (all tracked ASINs)
  const mktC = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
  const market = mktC.rows.length ? (mktC.rows[0].data||[]) : [];
  if (!market.length) return res.status(400).json({ error: 'No Keepa market data yet — refresh Market Data first.' });

  // our full stock picture per ASIN (available / committed / transit / FBA)
  const stockRows = await pool.query(`
    SELECT p.asin, p.hazmat, p.hazmat_source, COALESCE(s.onhand,0) AS onhand, COALESCE(s.transit,0) AS transit,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
        + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      )::int AS pending_prep,
      (
        COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
        + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=p.asin),0)
      )::int AS prepped
    FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin`);
  const stockByAsin = {}; for (const r of stockRows.rows) stockByAsin[r.asin] = r;
  // Hazmat for EVERY tracked ASIN, carried or not.
  const hazByAsin = {};
  try {
    const hz = await pool.query('SELECT asin, hazmat, source FROM inv_hazmat');
    for (const r of hz.rows) hazByAsin[r.asin] = r;
  } catch (e) {}
  const carried = new Set(stockRows.rows.map(r=>r.asin));
  // FBA quantities from the last FBA pull
  let fbaByAsin = {};
  let transitViaDuoByAsin = {};
  try {
    const fc = await pool.query("SELECT data FROM inv_cache WHERE cache_key='fba_inventory'");
    if (fc.rows.length) for (const f of (fc.rows[0].data||[])) {
      // effective = own units + bottles sitting inside duos at Amazon
      fbaByAsin[f.asin] = (f.fba_effective != null ? f.fba_effective : (f.fba_total||0));
      transitViaDuoByAsin[f.asin] = f.transit_via_duo || 0;
    }
  } catch(e) {}

  // optional SmartScout enrichment (units/revenue where we have it)
  let ssByAsin = {};
  try {
    const ss = JSON.parse(fs.readFileSync(path.join(__dirname, 'smartscout_products.json'), 'utf8'));
    for (const p of ss) ssByAsin[p.asin] = p;
  } catch(e) { /* optional */ }

  const out = market.map(m => {
    const ss = ssByAsin[m.asin] || {};
    const st = stockByAsin[m.asin] || {};
    return {
      asin: m.asin,
      title: m.name || ss.title || m.asin,
      brand: ss.brand || '',
      salesRank: m.salesRank,               // Keepa — available for all
      keepaMonthly: m.monthlySold || null,  // Keepa units where available
      ssUnits: ss.units || null,            // SmartScout units (enrichment)
      ssRevenue: ss.revenue || null,
      sellers: m.offerCount,
      pickPackFee: m.pickPackFee,
      referralPct: m.referralPct,
      amazonHasBuyBox: m.amazonHasBuyBox,
      amazonOOS: m.amazonOOS,
      buyBoxPrice: m.buyBoxPrice,
      carried: carried.has(m.asin),
      hazmat: hazByAsin[m.asin] ? hazByAsin[m.asin].hazmat
              : ((st.hazmat === true || st.hazmat === false) ? st.hazmat : null),
      hazmatSource: hazByAsin[m.asin] ? hazByAsin[m.asin].source : (st.hazmat_source || null),
      available: st.onhand ? Math.max(0, st.onhand - (st.pending_prep||0) - (st.prepped||0)) : 0,
      pendingPrep: st.pending_prep||0,
      prepped: st.prepped||0,
      transit: (st.transit||0) + (transitViaDuoByAsin[m.asin]||0),
      fba: fbaByAsin[m.asin]||0,
    };
  });
  // default sort: not-carried first, then best sales rank (lowest = sells most)
  out.sort((a,b)=>{
    if((a.carried?1:0)!==(b.carried?1:0)) return (a.carried?1:0)-(b.carried?1:0);
    const ar=a.salesRank==null?1e12:a.salesRank, br=b.salesRank==null?1e12:b.salesRank;
    return ar-br;
  });
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
  const prodsRaw = await pool.query(`
    SELECT p.asin, p.sku, p.name, COALESCE(s.onhand,0) AS onhand, COALESCE(s.transit,0) AS transit,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
        + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      )::int AS pending_prep
    FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin`);
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
    // include component bottles riding inside duos, both at FBA and in transit
    const transit = (p.transit || 0) + (f.transit_via_duo || 0);
    const fbaTotal = (f.fba_effective != null ? f.fba_effective : (f.fba_total || 0));
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
    const canSendNow = (onhand - (p.pending_prep||0) - (preppedByAsin[p.asin]||0)) > 0;
    if (canSendNow) score += 5;

    const prepped = preppedByAsin[p.asin] || 0;
    const pendingPrep = p.pending_prep || 0;
    // FREE STOCK: on-hand minus everything already committed to a work order or
    // already boxed. Sending a number you cannot physically pick is worse than
    // sending none, so this — not raw on-hand — caps the suggestion.
    const available = Math.max(0, onhand - pendingPrep - prepped);
    // Coverage already heading to FBA. Pending-prep is deliberately EXCLUDED:
    // it has not been prepped, boxed or shipped, so it is not coverage yet.
    const coverage = fbaTotal + transit + prepped;
    const coverageDays = demandPerDay > 0 ? coverage / demandPerDay : null;
    let suggestedSend = null;
    if (demandPerDay > 0) {
      const TARGET_DAYS = 60;
      const target = Math.ceil(demandPerDay * TARGET_DAYS);
      const gap = target - coverage;
      suggestedSend = Math.max(0, Math.min(gap, available));
    }

    // only include items with some signal (selling OR ranked OR we hold stock)
    const canSend = available > 0;
    if (demandPerDay > 0 || salesRank != null || onhand > 0) {
      rows.push({
        asin: p.asin, name: p.name || m.title, onhand, transit, prepped, pendingPrep, available,
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
// ---- Background market-data job (avoids Railway request timeouts) ----
let mktJob = { running:false, done:false, error:null, startedAt:null, finishedAt:null, progress:'', count:0, tokensLeft:null };

app.post('/api/market-data/start', ownerAuth, async (req, res) => {
  if (mktJob.running) return res.json({ ok:true, alreadyRunning:true, job:mktJob });
  const opts = { minPrice: req.body && req.body.minPrice, maxAgeDays: req.body && req.body.maxAgeDays };
  mktJob = { running:true, done:false, error:null, startedAt:new Date(), finishedAt:null, progress:'starting…', count:0, tokensLeft:null, pulled:0, skippedCheap:0, skippedFresh:0, failed:[] };
  res.json({ ok:true, started:true });      // respond immediately

  // run in background
  (async () => {
    try {
      mktJob.progress = 'pulling from Keepa…';
      const result = await runMarketDataPull((msg)=>{ mktJob.progress = msg; }, opts);
      mktJob.count = result.count;
      mktJob.tokensLeft = result.tokensLeft;
      mktJob.pulled = result.pulled;
      mktJob.skippedCheap = result.skippedCheap;
      mktJob.skippedFresh = result.skippedFresh;
      mktJob.failed = result.failed || [];
      mktJob.done = true;
      mktJob.progress = 'complete';
    } catch (err) {
      mktJob.error = err.message || String(err);
      mktJob.progress = 'failed';
      console.error('[Market] background pull failed:', mktJob.error);
    } finally {
      mktJob.running = false;
      mktJob.finishedAt = new Date();
    }
  })();
});

app.get('/api/market-data/status', ownerAuth, (req, res) => res.json(mktJob));

// ============================================================
// MERCHANT-FULFILLED OPPORTUNITY SCAN
// Scans ONLY the ASINs we have stock for (token-efficient) to spot
// moments where Amazon is out of stock / not holding the buy box —
// i.e. we could list MFN and ship from our own warehouse right now.
// ============================================================
async function runMfnScan(onProgress) {
  // ASINs we physically have free stock for
  const stock = await pool.query(`
    SELECT p.asin, p.name, p.sku, p.image, COALESCE(s.onhand,0) AS onhand,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
        + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      )::int AS pending_prep,
      (
        COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
        + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=p.asin),0)
      )::int AS prepped
    FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin
    WHERE COALESCE(s.onhand,0) > 0`);

  const candidates = stock.rows
    .map(r => ({ ...r, available: Math.max(0, r.onhand - r.pending_prep - r.prepped) }))
    .filter(r => r.available > 0);

  if (!candidates.length) { await saveCache('mfn_opportunities', []); return { scanned: 0, opportunities: [] }; }

  // ---- Amazon availability comes from KEEPA ----
  // The SP-API Pricing endpoint anonymises competitor seller ids, so it cannot tell us
  // whether the Amazon retail offer exists. Keepa tracks that explicitly.
  if (onProgress) onProgress(`checking ${candidates.length} listings on Keepa…`);
  let kByAsin = {};
  try {
    const kr = await keepa.getProducts(candidates.map(c=>c.asin), onProgress);
    for (const p of (kr.products||[])) kByAsin[p.asin] = p;
  } catch (err) {
    throw new Error('Keepa lookup failed: ' + err.message);
  }

  const opportunities = [];
  for (const c of candidates) {
    const k = kByAsin[c.asin];
    if (!k) continue;

    const amazonOut = k.amazonOutOfStock === true;     // Keepa: Amazon has no live offer
    const fewOffers = (k.offerCount != null && k.offerCount <= 3);
    const sellsWell = (k.salesRank != null && k.salesRank < 20000);

    // Only a genuine opportunity if Amazon is actually NOT selling it
    if (!amazonOut) continue;

    let score = 5;
    if (fewOffers) score += 2;
    if (sellsWell) score += 2;
    if (k.monthlySold != null && k.monthlySold >= 200) score += 1;

    opportunities.push({
      asin: c.asin, name: c.name, sku: c.sku, image: c.image,
      available: c.available,
      amazonSelling: false,
      amazonPrice: k.amazonPrice ?? null,
      availabilityAmazon: k.availabilityAmazon ?? null,
      buyBoxPrice: k.buyBoxPrice ?? null,
      totalOffers: k.offerCount ?? null,
      salesRank: k.salesRank ?? null,
      monthlySold: k.monthlySold ?? null,
      checkedAt: new Date().toISOString(),
      score,
      reason: [
        '🔴 AMAZON NOT SELLING',
        fewOffers ? `Only ${k.offerCount} offers` : null,
        sellsWell ? 'Sells well' : null,
      ].filter(Boolean).join(' · ')
    });
  }
  opportunities.sort((a,b)=> b.score - a.score || (a.salesRank||1e12)-(b.salesRank||1e12));
  await saveCache('mfn_opportunities', opportunities);
  console.log(`[MFN] Scan complete: ${opportunities.length} opportunities from ${candidates.length} in-stock ASINs`);
  return { scanned: candidates.length, opportunities };
}

// manual trigger + status
let mfnJob = { running:false, lastRun:null, error:null, count:0, progress:'' };
app.post('/api/mfn-scan', ownerAuth, async (req, res) => {
  if (mfnJob.running) return res.json({ ok:true, alreadyRunning:true });
  mfnJob = { running:true, lastRun:mfnJob.lastRun, error:null, count:0 };
  res.json({ ok:true, started:true });
  try {
    const r = await runMfnScan((msg)=>{ mfnJob.progress = msg; });
    mfnJob.count = r.opportunities.length;
    mfnJob.lastRun = new Date();
    mfnJob.progress = 'complete';
  } catch(err) {
    mfnJob.error = err.message;
    console.error('[MFN] scan failed:', err.message);
  } finally { mfnJob.running = false; }
});
app.get('/api/mfn-status', ownerAuth, (req,res)=>res.json(mfnJob));

// scheduled: run twice a day (every 12h), first run 3 min after boot
setTimeout(()=>{ runMfnScan().catch(e=>console.error('[MFN] scheduled scan failed:', e.message)); }, 3*60*1000);
setInterval(()=>{ runMfnScan().catch(e=>console.error('[MFN] scheduled scan failed:', e.message)); }, 12*60*60*1000);

// Shared pull used by BOTH the direct endpoint and the background job
async function runMarketDataPull(onProgress, opts = {}) {
  if (!keepa.keyOk()) throw new Error('KEEPA_API_KEY not set in Railway variables');
  let asins;
  try { asins = JSON.parse(fs.readFileSync(path.join(__dirname, 'keepa_asins.json'), 'utf8')); }
  catch(e){ asins = []; }
  if (!asins.length) throw new Error('No target ASINs configured');

  const minPrice   = Number(opts.minPrice) || 0;     // skip cheap items entirely
  const maxAgeDays = Number(opts.maxAgeDays) || 0;   // 0 = refresh everything

  // ---- existing cache becomes the base, so a partial run still adds value ----
  const prev = {};
  try {
    const c = await pool.query("SELECT data FROM inv_cache WHERE cache_key='market_data'");
    if (c.rows.length) for (const m of (c.rows[0].data || [])) prev[m.asin] = m;
  } catch(e) {}

  const carried = new Set();
  try {
    const cr = await pool.query('SELECT asin FROM inv_products');
    for (const r of cr.rows) carried.add(r.asin);
  } catch(e) {}

  // ---- decide what actually needs pulling ----
  const now = Date.now();
  let skippedCheap = 0, skippedFresh = 0;
  const target = asins.filter(a => {
    const p = prev[a];
    // never skip something we stock — those numbers drive reordering
    if (carried.has(a)) return true;
    if (minPrice > 0 && p && p.buyBoxPrice != null && p.buyBoxPrice < minPrice) { skippedCheap++; return false; }
    if (maxAgeDays > 0 && p && p.updatedAt && (now - new Date(p.updatedAt).getTime()) < maxAgeDays*86400000) { skippedFresh++; return false; }
    return true;
  });

  if (onProgress) onProgress(`${target.length} ASINs to pull (${skippedCheap} under $${minPrice}, ${skippedFresh} still fresh)`);
  if (!target.length) {
    const items = Object.values(prev);
    return { count: items.length, tokensLeft: null, items, skippedCheap, skippedFresh, pulled: 0, failed: [] };
  }

  const onhandRows = await pool.query('SELECT p.asin, p.sku, p.name, s.onhand FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin');
  const byAsin = {}; for (const row of onhandRows.rows) byAsin[row.asin] = row;

  const merged = { ...prev };
  let pulled = 0, imgsSaved = 0;

  // ---- SAVE AFTER EVERY BATCH ----
  // Previously the cache was written once, at the very end. A single failed
  // batch threw the whole run away, which is why repeated refreshes never
  // moved the "last updated" stamp. Now every batch that lands is kept.
  const persistBatch = async (products, info) => {
    for (const p of products) {
      if (!p.asin) continue;
      const mine = byAsin[p.asin] || {};
      merged[p.asin] = {
        asin: p.asin,
        name: mine.name || p.title,
        onhand: mine.onhand || 0,
        salesRank: p.salesRank,
        monthlySold: p.monthlySold,
        buyBoxPrice: p.buyBoxPrice,
        amazonHasBuyBox: p.amazonHasBuyBox,
        amazonOOS: p.amazonOOS,
        offerCount: p.offerCount,
        pickPackFee: p.pickPackFee,
        referralPct: p.referralPct,
        updatedAt: new Date().toISOString(),
      };
      pulled++;
      if (p.image) {
        try { const u = await pool.query('UPDATE inv_products SET image=$1 WHERE asin=$2', [p.image, p.asin]); if (u.rowCount) imgsSaved++; } catch(e) {}
      }
    }
    const list = Object.values(merged);
    list.sort((a,b)=>{
      const ar = a.salesRank == null ? 1e12 : a.salesRank;
      const br = b.salesRank == null ? 1e12 : b.salesRank;
      return ar - br;
    });
    try {
      await saveCache('market_data', list);
      console.log(`[Market] Saved ${list.length} products after batch ${info.batchIndex + 1} (tokens left ${info.tokensLeft}).`);
    } catch(e) { console.error('[Market] batch save failed:', e.message); }
    if (onProgress) onProgress(`saved ${list.length} products · ${info.done}/${info.total} pulled · tokens ${info.tokensLeft}`);
  };

  const r = await keepa.getProducts(target, onProgress, persistBatch);

  const items = Object.values(merged);
  console.log(`[Market] Done. pulled ${pulled}, images ${imgsSaved}, failed batches ${(r.failed||[]).length}.`);
  return {
    count: items.length, tokensLeft: r.tokensLeft, items,
    pulled, skippedCheap, skippedFresh, failed: r.failed || []
  };
}


// Direct (synchronous) pull — kept for small sets; may time out on large ones
app.get('/api/market-data', ownerAuth, async (req, res) => {
  try {
    const r = await runMarketDataPull();
    res.json({ items: r.items, tokensLeft: r.tokensLeft });
  } catch(err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Background inventory-value job (avoids Railway request timeouts) ----
let valJob = { running:false, done:false, error:null, progress:'', count:0, startedAt:null, finishedAt:null };

app.post('/api/inventory-value/start', ownerAuth, async (req, res) => {
  if (valJob.running) return res.json({ ok:true, alreadyRunning:true, job:valJob });
  valJob = { running:true, done:false, error:null, progress:'starting…', count:0, startedAt:new Date(), finishedAt:null };
  res.json({ ok:true, started:true });
  (async () => {
    try {
      const r = await runInventoryValuePull((msg)=>{ valJob.progress = msg; });
      valJob.count = r.length; valJob.done = true; valJob.progress = 'complete';
    } catch (err) {
      valJob.error = err.message || String(err);
      valJob.progress = 'failed';
      console.error('[Value] background pull failed:', valJob.error);
    } finally { valJob.running = false; valJob.finishedAt = new Date(); }
  })();
});
app.get('/api/inventory-value/status', ownerAuth, (req,res)=>res.json(valJob));

// Inventory value (owner) — units on hand × cost, needs cost per item
async function runInventoryValuePull(onProgress) {
  // include everything we hold ANYWHERE: warehouse, in transit, or sitting at FBA
  let fbaAsins = new Set();
  try {
    const fc = await pool.query("SELECT data FROM inv_cache WHERE cache_key='fba_inventory'");
    if (fc.rows.length) {
      const d = fc.rows[0].data;
      const list = Array.isArray(d) ? d : (d.items || []);
      for (const f of list) if ((f.fba_total||0) > 0) fbaAsins.add(f.asin);
    }
  } catch(e) {}

  const rows = await pool.query(
    `SELECT p.asin, p.sku, p.name, COALESCE(s.onhand,0) AS onhand, COALESCE(s.transit,0) AS transit
     FROM inv_products p LEFT JOIN inv_stock s ON s.asin=p.asin
     WHERE COALESCE(s.onhand,0) > 0 OR COALESCE(s.transit,0) > 0 OR p.asin = ANY($1::text[])`,
    [[...fbaAsins]]);
  const asins = rows.rows.map(r => r.asin).filter(Boolean);
  console.log(`[Value] pricing ${asins.length} products (warehouse + transit + FBA)`);
  if (onProgress) onProgress(`pulling Amazon prices for ${asins.length} products…`);
  let retail = {};
  try { retail = await getMyPrices(asins, onProgress); }
  catch(e) { console.error('retail fetch failed:', e.message); }
  const out = rows.rows.map(r => ({ ...r, amazon_price: retail[r.asin] || null }));
  out.sort((a,b)=>((b.amazon_price||0)*b.onhand)-((a.amazon_price||0)*a.onhand));
  await saveCache('inventory_value', out);
  return out;
}

// Direct pull (may time out on large catalogs — prefer the background job)
app.get('/api/inventory-value', ownerAuth, async (req, res) => {
  try { res.json(await runInventoryValuePull()); }
  catch(err){ res.status(400).json({ error: err.message }); }
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
  // join with our warehouse on-hand by ASIN, including committed (pending prep + prepped)
  const ours = await pool.query(`
    SELECT p.asin, p.sku, p.name, s.onhand, s.transit,
      (
        COALESCE((SELECT qty FROM inv_pending_prep WHERE asin=p.asin AND is_duo=false),0)
        + COALESCE((SELECT SUM(pp.qty*b.qty) FROM inv_pending_prep pp JOIN inv_bundles b ON b.bundle_asin=pp.asin WHERE b.component_asin=p.asin),0)
      )::int AS pending_prep,
      (
        COALESCE((SELECT qty FROM inv_prepped WHERE asin=p.asin),0)
        + COALESCE((SELECT SUM(pr.qty*bc.qty) FROM inv_prepped pr JOIN inv_bundles bc ON bc.bundle_asin=pr.asin WHERE bc.component_asin=p.asin),0)
      )::int AS prepped
    FROM inv_products p JOIN inv_stock s ON s.asin=p.asin`);
  // ---- DEDUPE OUR SIDE BY ASIN ----
  // inv_products can hold several rows for one ASIN (different merchant SKUs),
  // and a JOIN would then repeat that ASIN's warehouse/transit numbers.
  const byAsin = {};
  for (const r of ours.rows) {
    if (!byAsin[r.asin] || (r.onhand||0) > (byAsin[r.asin].onhand||0)) byAsin[r.asin] = r;
  }

  // ---- AGGREGATE AMAZON'S SIDE BY ASIN ----
  // Amazon returns FBA inventory per SELLER SKU. One ASIN commonly has several
  // SKUs (old/new listings, duo variants). Emitting a row per SKU repeated the
  // SAME warehouse and transit figures for each one, so the table double- or
  // triple-counted. FBA quantities are summed across an ASIN's SKUs; warehouse
  // and transit are taken ONCE.
  const fbaByAsin = {};
  let fnskusSaved = 0;
  for (const sku in fba) {
    const f = fba[sku];
    if (!f.asin) continue;
    if (!fbaByAsin[f.asin]) fbaByAsin[f.asin] = { total:0, fulfillable:0, inbound:0, skus:[] };
    const a = fbaByAsin[f.asin];
    a.total       += f.total || 0;
    a.fulfillable += f.fulfillable || 0;
    a.inbound     += f.inbound || 0;
    a.skus.push(sku);

    if (f.fnSku) {
      let ur = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE sku=$2', [f.fnSku, sku]);
      if (ur.rowCount === 0) ur = await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2', [f.fnSku, f.asin]);
      if (ur.rowCount > 0) fnskusSaved++;
    }
  }
  console.log(`[FBA] Captured/updated ${fnskusSaved} FNSKUs. ${Object.keys(fba).length} SKUs collapsed to ${Object.keys(fbaByAsin).length} ASINs.`);

  // ---- DUO EXPLOSION ----
  // A duo at Amazon is ONE sellable unit but TWO physical bottles. FBA reports
  // it against the bundle ASIN only, so a component whose bottles are sitting
  // inside hundreds of duos reads as zero at FBA — and the reorder tools then
  // tell you to buy more of a bottle you already have plenty of. Prep already
  // explodes bundles into components; this does the same for FBA and transit.
  const bundles = await pool.query('SELECT bundle_asin, component_asin, qty FROM inv_bundles');
  const viaDuoFba = {}, viaDuoTransit = {};
  for (const b of bundles.rows) {
    const per = b.qty || 1;
    const bFba     = (fbaByAsin[b.bundle_asin] || {}).total || 0;
    const bTransit = (byAsin[b.bundle_asin] || {}).transit || 0;
    if (bFba)     viaDuoFba[b.component_asin]     = (viaDuoFba[b.component_asin]     || 0) + bFba * per;
    if (bTransit) viaDuoTransit[b.component_asin] = (viaDuoTransit[b.component_asin] || 0) + bTransit * per;
  }

  const out = [];
  const allAsins = new Set([...Object.keys(byAsin), ...Object.keys(fbaByAsin)]);
  for (const asin of allAsins) {
    const o = byAsin[asin] || {};
    const a = fbaByAsin[asin] || { total:0, fulfillable:0, inbound:0, skus:[] };
    const warehouse = o.onhand || 0;
    const transit   = o.transit || 0;
    const fbaViaDuo     = viaDuoFba[asin] || 0;
    const transitViaDuo = viaDuoTransit[asin] || 0;
    out.push({
      asin,
      sku: o.sku || a.skus[0] || '',
      skuCount: a.skus.length,
      name: o.name || a.skus[0] || asin,
      warehouse, transit,
      pending_prep: o.pending_prep || 0,
      prepped: o.prepped || 0,
      available: Math.max(0, warehouse - (o.pending_prep||0) - (o.prepped||0)),
      // fba_total stays THIS ASIN's own units so page totals never double-count
      fba_total: a.total, fba_fulfillable: a.fulfillable, fba_inbound: a.inbound,
      // …and the effective figures include bottles held inside duos. Reorder
      // maths must use these, display totals must not.
      fba_via_duo: fbaViaDuo,
      transit_via_duo: transitViaDuo,
      fba_effective: a.total + fbaViaDuo,
      transit_effective: transit + transitViaDuo,
      grand_total: warehouse + transit + a.total
    });
  }
  out.sort((a,b)=>b.grand_total-a.grand_total);

  // PERSIST — products-to-add and the restock plan read this cache. Nothing
  // wrote it before, so both were treating FBA stock as zero.
  try {
    await saveCache('fba_inventory', out);
    console.log(`[FBA] Cached ${out.length} ASINs.`);
  } catch(e) { console.error('[FBA] cache save failed (non-fatal):', e.message); }

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
// PENDING PREP (work orders — what the owner wants prepped)
// ============================================================

// Create a prep request
app.post('/api/pending-prep/add', auth, async (req, res) => {
  const { asin, qty, isDuo } = req.body;
  const q = parseInt(qty);
  if (!asin || !q || q < 1) return res.status(400).json({ error: 'asin + qty required' });

  // If marked as duo, the asin passed should be a component; find the duo it belongs to.
  let requestAsin = asin, duoFlag = false;
  if (isDuo) {
    // is this asin already a bundle (duo) itself?
    const isBundle = await pool.query('SELECT 1 FROM inv_bundles WHERE bundle_asin=$1 LIMIT 1', [asin]);
    if (isBundle.rows.length) { requestAsin = asin; duoFlag = true; }
    else {
      // it's a component — find a duo containing it
      const b = await pool.query('SELECT bundle_asin FROM inv_bundles WHERE component_asin=$1 LIMIT 1', [asin]);
      if (!b.rows.length) return res.status(400).json({ error: 'This item is not part of any duo.' });
      requestAsin = b.rows[0].bundle_asin; duoFlag = true;
    }
  }

  // merge with an existing open request for the same item
  const ex = await pool.query('SELECT id, qty FROM inv_pending_prep WHERE asin=$1 AND is_duo=$2', [requestAsin, duoFlag]);
  if (ex.rows.length) {
    await pool.query('UPDATE inv_pending_prep SET qty = qty + $1 WHERE id=$2', [q, ex.rows[0].id]);
  } else {
    await pool.query('INSERT INTO inv_pending_prep(asin, qty, is_duo) VALUES($1,$2,$3)', [requestAsin, q, duoFlag]);
  }
  res.json({ ok: true, asin: requestAsin, qty: q, isDuo: duoFlag });
});

// List pending prep (worker's task list)
app.get('/api/pending-prep/list', auth, async (req, res) => {
  const rows = await pool.query(
    `SELECT pp.id, pp.asin, pp.qty, pp.is_duo, pp.claimed_by, pp.claimed_at, pp.in_plan, pp.in_plan_at, p.name, p.sku, p.fnsku, p.image, p.location
     FROM inv_pending_prep pp JOIN inv_products p ON p.asin = pp.asin
     WHERE pp.qty > 0 ORDER BY (pp.claimed_by IS NULL), pp.created_at`);
  // for duos, also return the component names so the worker knows what to grab
  const out = [];
  for (const r of rows.rows) {
    let components = [];
    if (r.is_duo) {
      const c = await pool.query(
        `SELECT b.component_asin AS asin, p.name, p.location, COALESCE(s.onhand,0) AS onhand
         FROM inv_bundles b JOIN inv_products p ON p.asin=b.component_asin
         LEFT JOIN inv_stock s ON s.asin=b.component_asin
         WHERE b.bundle_asin=$1`, [r.asin]);
      components = c.rows;
    }
    out.push({ ...r, components });
  }
  // Units AS SHIPPED — a duo is ONE sellable unit (one FNSKU), matching Amazon/3rd-party plan counts
  const totalUnits = out.reduce((s,x)=> s + x.qty, 0);
  // Bottles actually handled on the floor (duo = 2 bottles) — for prep-labor context
  const totalBottles = out.reduce((s,x)=> s + (x.is_duo ? x.qty*2 : x.qty), 0);
  const duoCount = out.filter(x=>x.is_duo).reduce((s,x)=> s + x.qty, 0);

  // Who is on each job right now, and since when.
  try {
    const cr = await pool.query(
      'SELECT job_id, employee, joined_at FROM inv_prep_crew WHERE left_at IS NULL ORDER BY joined_at');
    const byJob = {};
    for (const c of cr.rows) (byJob[c.job_id] = byJob[c.job_id] || []).push({ employee: c.employee, since: c.joined_at });
    for (const x of out) x.crew = byJob[x.id] || [];
  } catch (e) {
    for (const x of out) x.crew = [];
  }

  res.json({ items: out, totalRequests: out.length, totalUnits, totalBottles, duoCount });
});

// Mark / unmark a job as added to the 3rd-party shipment plan software
app.post('/api/pending-prep/in-plan', auth, async (req, res) => {
  const { id, inPlan } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  if (inPlan) await pool.query('UPDATE inv_pending_prep SET in_plan=true, in_plan_at=now() WHERE id=$1', [id]);
  else await pool.query('UPDATE inv_pending_prep SET in_plan=false, in_plan_at=NULL WHERE id=$1', [id]);
  res.json({ ok: true });
});

// Claim a prep job (worker starts on it)
// Resolve a submitted name to an active team member, or null.
async function resolveEmployee(name) {
  const who = String(name || '').trim();
  if (!who) return null;
  const r = await pool.query(
    'SELECT display_name FROM inv_employees WHERE active AND lower(display_name)=lower($1)', [who]);
  return r.rows.length ? r.rows[0].display_name : null;
}

// Is this person already open on a DIFFERENT job?
async function openJobElsewhere(employee, exceptJobId) {
  const r = await pool.query(
    `SELECT c.job_id, c.joined_at, p.name
     FROM inv_prep_crew c
     LEFT JOIN inv_pending_prep pp ON pp.id = c.job_id
     LEFT JOIN inv_products p ON p.asin = pp.asin
     WHERE c.left_at IS NULL AND lower(c.employee)=lower($1) AND c.job_id <> $2
       AND pp.id IS NOT NULL
     LIMIT 1`, [employee, exceptJobId || -1]);
  return r.rows.length ? { id: r.rows[0].job_id, name: r.rows[0].name || 'another item', since: r.rows[0].joined_at } : null;
}

// Add a prepper to a job that is already running.
app.post('/api/pending-prep/crew/join', auth, async (req, res) => {
  const { id, name } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const who = await resolveEmployee(name);
  if (!who) return res.status(400).json({ error: 'Pick your name from the list.' });

  const dup = await pool.query(
    'SELECT 1 FROM inv_prep_crew WHERE job_id=$1 AND lower(employee)=lower($2) AND left_at IS NULL', [id, who]);
  if (dup.rows.length) return res.json({ ok: false, already: true, employee: who });

  const busy = await openJobElsewhere(who, id);
  if (busy) return res.json({ ok: false, alreadyOnJob: true, other: busy });

  await pool.query('INSERT INTO inv_prep_crew(job_id, employee) VALUES($1,$2)', [id, who]);
  res.json({ ok: true, employee: who });
});

// One person steps off a job that keeps running.
app.post('/api/pending-prep/crew/leave', auth, async (req, res) => {
  const { id, name } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id + name required' });
  const r = await pool.query(
    `UPDATE inv_prep_crew SET left_at=now()
     WHERE job_id=$1 AND lower(employee)=lower($2) AND left_at IS NULL RETURNING employee, joined_at`,
    [id, name]);
  if (!r.rows.length) return res.json({ ok: false, notOnJob: true });

  // If that was the last one, the job goes back to unclaimed.
  const left = await pool.query('SELECT employee FROM inv_prep_crew WHERE job_id=$1 AND left_at IS NULL', [id]);
  if (!left.rows.length) {
    await pool.query('UPDATE inv_pending_prep SET claimed_by=NULL, claimed_at=NULL WHERE id=$1', [id]);
  } else {
    await pool.query('UPDATE inv_pending_prep SET claimed_by=$1 WHERE id=$2', [left.rows[0].employee, id]);
  }
  res.json({ ok: true, employee: r.rows[0].employee, remaining: left.rows.length });
});

app.post('/api/pending-prep/claim', auth, async (req, res) => {
  const { id, name } = req.body;
  const who = (name||'').trim();
  if (!id || !who) return res.status(400).json({ error: 'id + name required' });

  // Free text produced "Z", "Sam" and "ZAIA" for one person, which cannot be
  // matched to timesheets later. Only a listed team member may claim.
  const canonical = await resolveEmployee(who);
  if (!canonical) return res.status(400).json({ error: 'Pick your name from the list — free text is not accepted.' });

  const cur = await pool.query('SELECT claimed_by FROM inv_pending_prep WHERE id=$1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Job not found' });

  // ONE JOB AT A TIME per person.
  const busy = await openJobElsewhere(canonical, id);
  if (busy) return res.json({ ok: false, alreadyOnJob: true, other: busy });

  const already = await pool.query(
    'SELECT 1 FROM inv_prep_crew WHERE job_id=$1 AND lower(employee)=lower($2) AND left_at IS NULL', [id, canonical]);
  if (!already.rows.length) {
    await pool.query('INSERT INTO inv_prep_crew(job_id, employee) VALUES($1,$2)', [id, canonical]);
  }
  if (!cur.rows[0].claimed_by) {
    await pool.query('UPDATE inv_pending_prep SET claimed_by=$1, claimed_at=now() WHERE id=$2', [canonical, id]);
  }
  res.json({ ok: true, claimedBy: canonical });
});

// Release a claim
// Release the WHOLE job — everyone still on it steps off.
app.post('/api/pending-prep/release', auth, async (req, res) => {
  const id = req.body && req.body.id;
  await pool.query('UPDATE inv_prep_crew SET left_at=now() WHERE job_id=$1 AND left_at IS NULL', [id]);
  await pool.query('UPDATE inv_pending_prep SET claimed_by=NULL, claimed_at=NULL WHERE id=$1', [id]);
  res.json({ ok: true });
});

// Delete a single prep log entry (for removing test data)
app.post('/api/prep-log/delete', auth, async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  await pool.query('DELETE FROM inv_prep_log WHERE id=$1', [id]);
  res.json({ ok: true });
});

// Clear ALL prep log entries (wipe test data)
app.post('/api/prep-log/clear-all', auth, async (req, res) => {
  const r = await pool.query('DELETE FROM inv_prep_log');
  res.json({ ok: true, deleted: r.rowCount });
});

// Prep performance metrics — recent jobs + per-worker + per-ASIN productivity
app.get('/api/prep-performance', auth, async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days*24*60*60*1000).toISOString();

  const recent = await pool.query(
    `SELECT id, asin, name, qty, is_duo, units, worker, started_at, finished_at, duration_sec
     FROM inv_prep_log WHERE finished_at >= $1 ORDER BY finished_at DESC LIMIT 100`, [since]);

  const byWorker = await pool.query(
    `SELECT worker,
            COUNT(*)::int AS jobs,
            SUM(units)::int AS units,
            SUM(duration_sec)::int AS total_sec,
            CASE WHEN SUM(duration_sec) > 0
              THEN ROUND(SUM(units)::numeric / (SUM(duration_sec)::numeric/3600), 1)
              ELSE NULL END AS units_per_hour
     FROM inv_prep_log WHERE finished_at >= $1 AND duration_sec IS NOT NULL
     GROUP BY worker ORDER BY units DESC`, [since]);

  const byAsin = await pool.query(
    `SELECT asin, name,
            COUNT(*)::int AS jobs,
            SUM(units)::int AS units,
            SUM(duration_sec)::int AS total_sec,
            CASE WHEN SUM(duration_sec) > 0
              THEN ROUND(SUM(units)::numeric / (SUM(duration_sec)::numeric/3600), 1)
              ELSE NULL END AS units_per_hour
     FROM inv_prep_log WHERE finished_at >= $1 AND duration_sec IS NOT NULL
     GROUP BY asin, name ORDER BY units_per_hour ASC NULLS LAST`, [since]);

  const totals = await pool.query(
    `SELECT COUNT(*)::int AS jobs, COALESCE(SUM(units),0)::int AS units,
            COALESCE(SUM(duration_sec),0)::int AS total_sec
     FROM inv_prep_log WHERE finished_at >= $1`, [since]);

  const t = totals.rows[0];
  const overallUPH = t.total_sec > 0 ? Math.round((t.units / (t.total_sec/3600)) * 10)/10 : null;

  res.json({ days, recent: recent.rows, byWorker: byWorker.rows, byAsin: byAsin.rows,
             totals: { ...t, unitsPerHour: overallUPH } });
});

// Complete a prep job WITHOUT scanning — moves it straight to Prepped & Ready
app.post('/api/pending-prep/complete', auth, async (req, res) => {
  const { id, qty, completedBy } = req.body;
  const q = parseInt(qty);
  if (!id || !q || q < 1) return res.status(400).json({ error: 'id + qty required' });

  const job = await pool.query('SELECT asin, qty, is_duo, claimed_by, claimed_at FROM inv_pending_prep WHERE id=$1', [id]);
  if (!job.rows.length) return res.status(404).json({ error: 'Job not found' });
  const { asin, qty: requested, is_duo } = job.rows[0];
  const who = (completedBy || job.rows[0].claimed_by || 'unknown').trim();

  // availability warning (component-level for duos)
  const parts = await expandToComponents(asin, q);
  const warnings = [];
  for (const part of parts) {
    const st = await pool.query('SELECT onhand FROM inv_stock WHERE asin=$1', [part.asin]);
    const onhand = st.rows[0]?.onhand || 0;
    const committed = await componentCommitted(part.asin);
    const nm = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [part.asin]);
    if (committed + part.qty > onhand) {
      warnings.push({ name: nm.rows[0]?.name || part.asin, onhand, committed, adding: part.qty });
    }
  }

  // move into Prepped & Ready (stored as-scanned: duo asin or single asin)
  await pool.query('INSERT INTO inv_prepped(asin, qty) VALUES($1,$2) ON CONFLICT (asin) DO UPDATE SET qty = inv_prepped.qty + $2, updated_at=now()', [asin, q]);
  const nm = await pool.query('SELECT name FROM inv_products WHERE asin=$1', [asin]);
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
    ['prep', asin, nm.rows[0]?.name || asin, q, 'Prep completed by ' + who + (is_duo ? ' (duo)' : '')]);

  // ---- record prep performance ----
  try {
    const startedAt = job.rows[0].claimed_at || null;
    const durSec = startedAt ? Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime())/1000)) : null;
    const unitsHandled = is_duo ? q * 2 : q;
    await pool.query(
      `INSERT INTO inv_prep_log(asin, name, qty, is_duo, units, worker, started_at, duration_sec)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [asin, nm.rows[0]?.name || asin, q, is_duo, unitsHandled, who, startedAt, durSec]);
  } catch(e) { console.error('prep log failed:', e.message); }

  // decrement / close the work order
  const remaining = requested - q;
  if (remaining <= 0) await pool.query('DELETE FROM inv_pending_prep WHERE id=$1', [id]);
  else await pool.query('UPDATE inv_pending_prep SET qty=$1, claimed_by=NULL, claimed_at=NULL WHERE id=$2', [remaining, id]);

  res.json({ ok: true, moved: q, requested, remaining: Math.max(0, remaining), over: remaining < 0 ? Math.abs(remaining) : 0, isDuo: is_duo, warnings, completedBy: who });
});

// Adjust / remove a pending prep request
app.post('/api/pending-prep/set', auth, async (req, res) => {
  const { id, qty } = req.body;
  const q = parseInt(qty) || 0;
  if (q <= 0) await pool.query('DELETE FROM inv_pending_prep WHERE id=$1', [id]);
  else await pool.query('UPDATE inv_pending_prep SET qty=$1 WHERE id=$2', [q, id]);
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
// Look up which product currently has a given FNSKU
app.get('/api/fnsku-lookup/:fnsku', auth, async (req, res) => {
  const fn = req.params.fnsku.trim();
  const r = await pool.query('SELECT asin, name, sku FROM inv_products WHERE UPPER(fnsku)=UPPER($1)', [fn]);
  res.json({ found: r.rows.length>0, products: r.rows });
});

// Re-map an FNSKU to the correct product (clears it from any wrong product first)
app.post('/api/remap-fnsku', auth, async (req, res) => {
  const { fnsku, asin } = req.body;
  const fn = (fnsku||'').trim();
  if (!fn || !asin) return res.status(400).json({ error: 'fnsku + asin required' });
  // clear this FNSKU from any product that wrongly has it
  await pool.query("UPDATE inv_products SET fnsku=NULL WHERE UPPER(fnsku)=UPPER($1)", [fn]);
  // assign to the correct product
  await pool.query('UPDATE inv_products SET fnsku=$1 WHERE asin=$2', [fn, asin]);
  res.json({ ok: true });
});

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
  // decrement the matching PENDING PREP work order (if any)
  let pendingInfo = null;
  const pend = await pool.query('SELECT id, qty FROM inv_pending_prep WHERE asin=$1', [prod.asin]);
  if (pend.rows.length) {
    const remaining = pend.rows[0].qty - q;
    pendingInfo = { requested: pend.rows[0].qty, scanned: q, remaining: Math.max(0, remaining), over: remaining < 0 ? Math.abs(remaining) : 0 };
    if (remaining <= 0) await pool.query('DELETE FROM inv_pending_prep WHERE id=$1', [pend.rows[0].id]);
    else await pool.query('UPDATE inv_pending_prep SET qty=$1 WHERE id=$2', [remaining, pend.rows[0].id]);
  }
  await pool.query('INSERT INTO inv_activity(direction,asin,name,qty,note) VALUES($1,$2,$3,$4,$5)',
    ['prep', prod.asin, prod.name, q, isBundle ? 'Prepped duo' : 'Prepped']);

  res.json({ ok: true, product: prod, qty: q, isBundle, warnings, pendingInfo });
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
    `SELECT pr.asin, p.name, p.sku, p.fnsku, p.image, p.upc, pr.qty AS prepped, s.onhand
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
  app.listen(PORT, () => { console.log(`[Inventory] BUILD ${BUILD_ID}`); console.log(`[Inventory] Live on port ${PORT}`); });
}).catch(err => {
  console.error('[Inventory] DB init failed:', err.message);
  // Start anyway so you can see errors
  app.listen(PORT, () => console.log(`[Inventory] Started (DB error) on port ${PORT}`));
});

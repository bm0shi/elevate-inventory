// ============================================================
// STOCK-MOVING ROUTES, end to end: a real server on a throwaway database,
// driven like a worker would (receive, check in an invoice, prep, ship,
// undo, count), then the numbers are checked. The cases are the ways stock
// has gone wrong before: a double tap, two tablets at once, a retry after a
// dropped connection, doing a once-only action twice.
//
//   TEST_DATABASE_URL=postgres://.../elevate_test npm run test:routes
//
// The database is WIPED first, so the name must contain "test". Skipped
// when TEST_DATABASE_URL isn't set (plain `npm test` stays database-free).
// No Amazon or Keepa keys are passed, so nothing leaves the machine.
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL ? 'TEST_DATABASE_URL not set' : (!/test/i.test(URL.split('/').pop() || '') ? 'database name must contain "test" (it gets wiped)' : false);
const PORT = 3900 + Math.floor(Math.random() * 90);
const APP = 'app-pw', OWNER = 'owner-pw';
let server, pool;

const H = (extra) => Object.assign({ 'Content-Type': 'application/json', 'x-app-password': APP }, extra || {});
async function post(p, body, { idem, owner } = {}) {
  const r = await fetch(`http://localhost:${PORT}${p}`, { method: 'POST', headers: H(Object.assign(idem ? { 'x-idem-key': idem } : {}, owner ? { 'x-owner-password': OWNER } : {})), body: JSON.stringify(body || {}) });
  let json = null; try { json = await r.json(); } catch (e) {}
  return { status: r.status, body: json };
}
const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
const stock = async (asin) => (await one('SELECT COALESCE(onhand,0)::int AS onhand, COALESCE(transit,0)::int AS transit FROM inv_stock WHERE asin=$1', [asin])) || { onhand: 0, transit: 0 };
const prepped = async (asin) => ((await one('SELECT qty FROM inv_prepped WHERE asin=$1', [asin])) || { qty: 0 }).qty;
const pending = async (asin) => ((await one('SELECT COALESCE(SUM(qty),0)::int AS q FROM inv_pending_prep WHERE asin=$1', [asin])) || { q: 0 }).q;

test.before(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: URL });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  server = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: { PATH: process.env.PATH, DATABASE_URL: URL, PORT: String(PORT), APP_PASSWORD: APP, OWNER_PASSWORD: OWNER },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start:\n' + log)), 60000);
    const on = (d) => { log += d; if (/Live on port/.test(log)) { clearTimeout(t); resolve(); } if (/DB init failed/.test(log)) { clearTimeout(t); reject(new Error(log)); } };
    server.stdout.on('data', on); server.stderr.on('data', on);
  });
  // Two bottles and the duo made of one of each.
  await pool.query(`INSERT INTO inv_products(asin, name, sku) VALUES ('TSTA','Test Shampoo','SKU-A'),('TSTB','Test Conditioner','SKU-B'),('TSTDUO','Test Duo','SKU-DUO') ON CONFLICT (asin) DO NOTHING`);
  await pool.query(`INSERT INTO inv_bundles(bundle_asin, component_asin, qty) VALUES ('TSTDUO','TSTA',1),('TSTDUO','TSTB',1)`);
});
test.after(async () => { if (server) server.kill(); if (pool) await pool.end(); });

test('receive adds exactly what was scanned; nonsense quantities are refused', { skip }, async () => {
  const before = (await stock('TSTA')).onhand;
  assert.strictEqual((await post('/api/receive', { asin: 'TSTA', qty: 24 })).status, 200);
  assert.strictEqual((await stock('TSTA')).onhand, before + 24);
  // A barcode typed into the qty box
  assert.strictEqual((await post('/api/receive', { asin: 'TSTA', qty: 850000123456 })).status, 400);
  assert.strictEqual((await post('/api/receive', { asin: 'NOPE', qty: 1 })).status, 404);
  assert.strictEqual((await stock('TSTA')).onhand, before + 24);
});

test('a double tap (same action id) receives once', { skip }, async () => {
  const before = (await stock('TSTB')).onhand;
  const a = await post('/api/receive', { asin: 'TSTB', qty: 10 }, { idem: 'tap-1' });
  const b = await post('/api/receive', { asin: 'TSTB', qty: 10 }, { idem: 'tap-1' });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);   // the first reply, replayed
  assert.strictEqual((await stock('TSTB')).onhand, before + 10);
});

test('an invoice checks in once, even when two tablets complete it at the same moment', { skip }, async () => {
  await pool.query(`INSERT INTO inv_invoices(order_number, status) VALUES ('INV-T1','pending')`);
  await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received) VALUES ('INV-T1','111','Test Shampoo','TSTA',12,12)`);
  const before = (await stock('TSTA')).onhand;
  const [r1, r2] = await Promise.all([post('/api/invoices/INV-T1/complete', {}), post('/api/invoices/INV-T1/complete', {})]);
  assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.strictEqual((await stock('TSTA')).onhand, before + 12);
  // and a third try later still changes nothing
  assert.strictEqual((await post('/api/invoices/INV-T1/complete', {})).status, 409);
  assert.strictEqual((await stock('TSTA')).onhand, before + 12);
});

test('an invoice with an unmapped line stops instead of silently dropping units', { skip }, async () => {
  await pool.query(`INSERT INTO inv_invoices(order_number, status) VALUES ('INV-T2','pending')`);
  await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received) VALUES ('INV-T2','222','Mystery item',NULL,5,5)`);
  const r = await post('/api/invoices/INV-T2/complete', {});
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, 'unmapped_lines');
  assert.strictEqual((await one(`SELECT status FROM inv_invoices WHERE order_number='INV-T2'`)).status, 'pending');
});

test('a duo work order: two taps together make one order, not two', { skip }, async () => {
  const [a, b] = await Promise.all([
    post('/api/pending-prep/add', { asin: 'TSTA', qty: 5, isDuo: true, duoAsin: 'TSTDUO' }),
    post('/api/pending-prep/add', { asin: 'TSTA', qty: 5, isDuo: true, duoAsin: 'TSTDUO' }),
  ]);
  assert.strictEqual(a.status, 200); assert.strictEqual(b.status, 200);
  const rows = (await pool.query(`SELECT qty FROM inv_pending_prep WHERE asin='TSTDUO'`)).rows;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].qty, 10);
  // A duo that doesn't contain the bottle is refused
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTA', qty: 1, isDuo: true, duoAsin: 'TSTB' })).status, 400);
});

test('finishing the same prep job twice at once moves it to Prepped once', { skip }, async () => {
  const job = await one(`SELECT id, qty FROM inv_pending_prep WHERE asin='TSTDUO'`);
  const before = await prepped('TSTDUO');
  const [a, b] = await Promise.all([
    post('/api/pending-prep/complete', { id: job.id, qty: job.qty, completedBy: 'Tester' }),
    post('/api/pending-prep/complete', { id: job.id, qty: job.qty, completedBy: 'Tester' }),
  ]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  assert.strictEqual(await prepped('TSTDUO'), before + job.qty);
  assert.strictEqual(await pending('TSTDUO'), 0);
});

test('a prep scan counts down its work order, and undo puts both back', { skip }, async () => {
  await post('/api/pending-prep/add', { asin: 'TSTB', qty: 6 });
  const p0 = await prepped('TSTB');
  const s = await post('/api/prep/scan', { code: 'TSTB', qty: 4 });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(await prepped('TSTB'), p0 + 4);
  assert.strictEqual(await pending('TSTB'), 2);
  assert.strictEqual((await post('/api/undo/' + s.body.undoId, {})).status, 200);
  assert.strictEqual(await prepped('TSTB'), p0);
  assert.strictEqual(await pending('TSTB'), 6);
  // Undoing twice does nothing the second time
  assert.strictEqual((await post('/api/undo/' + s.body.undoId, {})).status, 409);
  assert.strictEqual(await prepped('TSTB'), p0);
});

test('shipping a duo takes one of each bottle; posting the same shipment again is refused', { skip }, async () => {
  const A = await stock('TSTA'), B = await stock('TSTB'), duoPrepped = await prepped('TSTDUO');
  const r = await post('/api/bulk-ship', { shipmentId: 'FBATEST1', shipmentName: 'Test ship', items: [{ code: 'SKU-DUO', qty: 3 }, { code: 'TSTA', qty: 2 }] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(await stock('TSTA'), { onhand: A.onhand - 5, transit: A.transit + 5 });
  assert.deepStrictEqual(await stock('TSTB'), { onhand: B.onhand - 3, transit: B.transit + 3 });
  assert.strictEqual(await prepped('TSTDUO'), Math.max(0, duoPrepped - 3));   // the prepped duos it used
  const again = await post('/api/bulk-ship', { shipmentId: 'FBATEST1', items: [{ code: 'SKU-DUO', qty: 3 }] });
  assert.strictEqual(again.status, 409);
  assert.deepStrictEqual(await stock('TSTA'), { onhand: A.onhand - 5, transit: A.transit + 5 });
});

test('marking a shipment received clears its transit once', { skip }, async () => {
  const A = await stock('TSTA');
  const [a, b] = await Promise.all([post('/api/receive-shipment', { shipmentId: 'FBATEST1' }), post('/api/receive-shipment', { shipmentId: 'FBATEST1' })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  assert.strictEqual((await stock('TSTA')).transit, Math.max(0, A.transit - 5));
  assert.strictEqual((await post('/api/receive-shipment', { shipmentId: 'FBATEST1' })).status, 409);
  assert.strictEqual((await stock('TSTA')).transit, Math.max(0, A.transit - 5));
});

test('a cycle count sets on hand to what was counted plus what is prepped (bottles inside prepped duos too)', { skip }, async () => {
  await post('/api/prep/scan', { code: 'TSTB', qty: 2 });
  // Prepped bottles aren't on the shelf being counted, but they're still ours.
  const staged = await prepped('TSTB') + await prepped('TSTDUO');
  const r = await post('/api/count/apply', { location: 'A-1', countedBy: 'Tester', counts: [{ asin: 'TSTB', counted: 7 }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await stock('TSTB')).onhand, 7 + staged);
  assert.strictEqual((await post('/api/count/apply', { location: 'A-1', counts: [{ asin: 'TSTB', counted: -3 }] })).status, 400);
});

test('staff cannot reach owner routes', { skip }, async () => {
  assert.strictEqual((await post('/api/capacity/limit', { standard: 1 })).status, 403);
  assert.strictEqual((await fetch(`http://localhost:${PORT}/api/backup/download`, { headers: H() })).status, 403);
  assert.strictEqual((await fetch(`http://localhost:${PORT}/api/plan/data`, { headers: H() })).status, 403);
});

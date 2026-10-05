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
  await pool.query(`INSERT INTO inv_products(asin, name, sku, fnsku) VALUES ('TSTA','Test Shampoo','SKU-A','X00TESTAAA'),('TSTB','Test Conditioner','SKU-B','X00TESTBBB'),('TSTDUO','Test Duo','SKU-DUO','X00TESTDUO') ON CONFLICT (asin) DO NOTHING`);
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

test('a short invoice line is saved as owed; late units come in once, never past what is owed', { skip }, async () => {
  await pool.query(`INSERT INTO inv_invoices(order_number, status) VALUES ('INV-T3','pending')`);
  await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received, unit_cost) VALUES ('INV-T3','333','Test Shampoo','TSTA',197,0,5.00),('INV-T3','334','Test Conditioner','TSTB',10,0,4.00)`);
  const lines = (await pool.query(`SELECT id, asin FROM inv_invoice_items WHERE order_number='INV-T3' ORDER BY id`)).rows;
  const [la, lb] = lines;
  // typed counts, by line
  assert.strictEqual((await post('/api/invoices/INV-T3/set-line', { id: la.id, qty_received: 149 })).status, 200);
  assert.strictEqual((await post('/api/invoices/INV-T3/set-line', { id: lb.id, qty_received: 10 })).status, 200);
  // late units are refused before the invoice is checked in
  assert.strictEqual((await post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 5 })).status, 409);
  const a0 = (await stock('TSTA')).onhand;
  assert.strictEqual((await post('/api/invoices/INV-T3/complete', {})).status, 200);
  assert.strictEqual((await stock('TSTA')).onhand, a0 + 149);
  assert.strictEqual((await one('SELECT qty_owed FROM inv_invoice_items WHERE id=$1', [la.id])).qty_owed, 48);
  assert.strictEqual((await one('SELECT qty_owed FROM inv_invoice_items WHERE id=$1', [lb.id])).qty_owed, 0);
  // a double tap of the same late receipt adds once
  const [r1, r2] = await Promise.all([
    post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 40 }, { idem: 'late-1' }),
    post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 40 }, { idem: 'late-1' })]);
  assert.ok([r1.status, r2.status].includes(200));
  assert.strictEqual((await stock('TSTA')).onhand, a0 + 189);
  // more than is still owed (8) is refused; nothing owed on a full line
  assert.strictEqual((await post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 9 })).status, 409);
  assert.strictEqual((await post('/api/invoices/INV-T3/receive-late', { id: lb.id, qty: 1 })).status, 409);
  assert.strictEqual((await post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 8 })).status, 200);
  assert.strictEqual((await stock('TSTA')).onhand, a0 + 197);
  const row = await one('SELECT qty_received, qty_owed FROM inv_invoice_items WHERE id=$1', [la.id]);
  assert.deepStrictEqual([row.qty_received, row.qty_owed], [197, 0]);
  assert.strictEqual((await one(`SELECT qty FROM inv_cost_history WHERE order_number='INV-T3' AND asin='TSTA'`)).qty, 197);
  assert.strictEqual((await post('/api/invoices/INV-T3/receive-late', { id: la.id, qty: 1 })).status, 409);
  const list = await (await fetch(`http://localhost:${PORT}/api/invoices`, { headers: H() })).json();
  assert.strictEqual(list.find(i => i.order_number === 'INV-T3').owed, 0);
});

test('Shortages: an owed line is listed; marking it credited moves it to history without touching stock', { skip }, async () => {
  await pool.query(`INSERT INTO inv_invoices(order_number, invoice_date, status) VALUES ('INV-T4','10/1/26','pending')`);
  await pool.query(`INSERT INTO inv_invoice_items(order_number, cosmo_num, description, asin, qty_expected, qty_received) VALUES ('INV-T4','444','Test Conditioner','TSTB',30,24)`);
  assert.strictEqual((await post('/api/invoices/INV-T4/complete', {})).status, 200);
  const get = async () => (await (await fetch(`http://localhost:${PORT}/api/shortages`, { headers: H() })).json()).rows.find(r => r.order_number === 'INV-T4');
  let r = await get();
  assert.deepStrictEqual([r.invoice_date, r.qty_expected, r.qty_received, r.qty_owed], ['10/1/26', 30, 24, 6]);
  const b0 = (await stock('TSTB')).onhand;
  assert.strictEqual((await post('/api/invoices/INV-T4/clear-owed', { id: r.id })).status, 200);
  assert.strictEqual((await post('/api/invoices/INV-T4/clear-owed', { id: r.id })).status, 404);
  r = await get();
  assert.deepStrictEqual([r.qty_owed, r.credited_qty], [0, 6]);
  assert.strictEqual((await stock('TSTB')).onhand, b0);
  assert.strictEqual((await post('/api/invoices/INV-T4/receive-late', { id: r.id, qty: 1 })).status, 409);
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

test('a job over 200 is split in half; both halves finish into one Prepped card; a scan spills into part 2', { skip }, async () => {
  await pool.query(`INSERT INTO inv_products(asin, name, sku, fnsku) VALUES ('TSTBIG','Test Liter','SKU-BIG','X00TESTBIG') ON CONFLICT (asin) DO NOTHING`);
  const halves = async () => (await pool.query(`SELECT id, qty, split_group, split_part FROM inv_pending_prep WHERE asin='TSTBIG' ORDER BY split_part, id`)).rows;
  // 300 → 150 + 150, linked; the same tap again (same action id) adds nothing
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTBIG', qty: 300 }, { idem: 'big-1' })).status, 200);
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTBIG', qty: 300 }, { idem: 'big-1' })).status, 200);
  let h = await halves();
  assert.deepStrictEqual(h.map(x => [x.qty, x.split_part]), [[150, 1], [150, 2]]);
  assert.strictEqual(h[0].split_group, h[1].split_group);
  // 101 more rebalances the free halves: 201 / 200
  await post('/api/pending-prep/add', { asin: 'TSTBIG', qty: 101 });
  h = await halves();
  assert.deepStrictEqual(h.map(x => x.qty), [201, 200]);
  // Each half finishes on its own; Prepped stays ONE row for the product
  const p0 = await prepped('TSTBIG');
  assert.strictEqual((await post('/api/pending-prep/complete', { id: h[0].id, qty: 201, completedBy: 'Tester' })).status, 200);
  const [a, b] = await Promise.all([
    post('/api/pending-prep/complete', { id: h[1].id, qty: 200, completedBy: 'Tester' }),
    post('/api/pending-prep/complete', { id: h[1].id, qty: 200, completedBy: 'Tester' }),
  ]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 409]);
  assert.strictEqual(await prepped('TSTBIG'), p0 + 401);
  assert.strictEqual((await one(`SELECT COUNT(*)::int AS n FROM inv_prepped WHERE asin='TSTBIG'`)).n, 1);
  assert.strictEqual(await pending('TSTBIG'), 0);
  // A scan of 200 against 150 + 150 empties part 1 and takes 50 from part 2;
  // undo brings part 1 back, still linked
  await post('/api/pending-prep/add', { asin: 'TSTBIG', qty: 300 });
  const g = (await halves())[0].split_group;
  const s = await post('/api/prep/scan', { code: 'TSTBIG', qty: 200 });
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual((await halves()).map(x => [x.qty, x.split_part]), [[100, 2]]);
  assert.strictEqual((await post('/api/undo/' + s.body.undoId, {})).status, 200);
  h = await halves();
  assert.deepStrictEqual(h.map(x => [x.qty, x.split_part, x.split_group]), [[150, 1, g], [150, 2, g]]);
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

test('On Hand fix count: missing units come off once, are logged, can be undone, and never go below prepped', { skip }, async () => {
  await post('/api/receive', { asin: 'TSTA', qty: 30 });
  const before = (await stock('TSTA')).onhand;
  const a = await post('/api/onhand/adjust', { asin: 'TSTA', delta: -12 }, { idem: 'fix-1' });
  const b = await post('/api/onhand/adjust', { asin: 'TSTA', delta: -12 }, { idem: 'fix-1' });   // double tap
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(b.status, 200);
  assert.strictEqual((await stock('TSTA')).onhand, before - 12);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_shrink WHERE asin=$1', ['TSTA'])).n, 1);
  // Undo puts the units back and drops the log line.
  assert.strictEqual((await post('/api/undo/' + a.body.undoId, {})).status, 200);
  assert.strictEqual((await stock('TSTA')).onhand, before);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_shrink WHERE asin=$1', ['TSTA'])).n, 0);
  // Nonsense and too many are refused, nothing changes.
  assert.strictEqual((await post('/api/onhand/adjust', { asin: 'TSTA', delta: 0 })).status, 400);
  assert.strictEqual((await post('/api/onhand/adjust', { asin: 'TSTA', delta: -850000123456 })).status, 400);
  assert.strictEqual((await post('/api/onhand/adjust', { asin: 'TSTA', delta: -(before + 1) })).status, 400);
  assert.strictEqual((await post('/api/onhand/adjust', { asin: 'NOPE', delta: -1 })).status, 404);
  assert.strictEqual((await stock('TSTA')).onhand, before);
});

test('a duo work order is refused past the bottles on hand (adding or raising it)', { skip }, async () => {
  await post('/api/receive', { asin: 'TSTA', qty: 200 }); await post('/api/receive', { asin: 'TSTB', qty: 200 });
  const huge = await post('/api/pending-prep/add', { asin: 'TSTDUO', qty: 5000, isDuo: true });
  assert.strictEqual(huge.status, 400);
  assert.ok(huge.body.notEnough && huge.body.short.length, JSON.stringify(huge.body));
  const can = Math.min(...huge.body.short.map(x => x.canBuild));
  assert.ok(can > 0, 'expected some duos buildable after receiving');
  const before = await pending('TSTDUO');
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTDUO', qty: can + 1, isDuo: true })).status, 400);
  assert.strictEqual(await pending('TSTDUO'), before);
  // Asked from a bottle's card, same rule.
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTA', qty: can + 1, isDuo: true, duoAsin: 'TSTDUO' })).status, 400);
  const ok = await post('/api/pending-prep/add', { asin: 'TSTDUO', qty: can, isDuo: true });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual(await pending('TSTDUO'), before + can);
  // Nothing left: one more is refused, and so is raising the work order.
  assert.strictEqual((await post('/api/pending-prep/add', { asin: 'TSTDUO', qty: 1, isDuo: true })).status, 400);
  const job = await one('SELECT id, qty FROM inv_pending_prep WHERE asin=$1 AND is_duo=true ORDER BY id LIMIT 1', ['TSTDUO']);
  assert.strictEqual((await post('/api/pending-prep/set', { id: job.id, qty: job.qty + 1 })).status, 400);
  assert.strictEqual((await post('/api/pending-prep/set', { id: job.id, qty: job.qty - 1 })).status, 200);   // lowering is fine
  // Leave the stock free for the tests after this one.
  await post('/api/pending-prep/set', { id: job.id, qty: 0 });
});

// No Amazon keys in tests, so the destination is entered by hand, as the
// floor would when Amazon's lookup can't give the street address.
async function confirmDest(SID) {
  const d = await post('/api/pack/destination', { shipmentId: SID, fc: 'MIT2',
    shipTo: { name: 'Amazon.com Services', line1: '5408 Express Avenue', city: 'Shafter', state: 'CA', zip: '93263', country: 'US' },
    shipFrom: { name: 'Test warehouse', line1: '1 Test Rd', city: 'Phoenix', state: 'AZ', zip: '85029', country: 'US' } });
  assert.strictEqual(d.status, 200, JSON.stringify(d.body));
  assert.strictEqual((await post('/api/pack/confirm', { shipmentId: SID })).status, 200);
}

test('pack boxes: scan, close (label text), finish deducts once; nothing changes after', { skip }, async () => {
  const SID = 'FBAPACKTEST1';
  assert.strictEqual((await post('/api/pack/start', { shipmentId: SID, name: 'Pack test' })).status, 200);
  await confirmDest(SID);
  await post('/api/receive', { asin: 'TSTA', qty: 50 }); await post('/api/receive', { asin: 'TSTB', qty: 50 });
  const A = await stock('TSTA'), B = await stock('TSTB');
  // Box 1: 4 singles of A (scanned by FNSKU) and 2 duos
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 1, code: 'X00TESTAAA', qty: 4 })).status, 200);
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 1, code: 'X00TESTDUO' })).status, 200);
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 1, code: 'X00TESTDUO' })).status, 200);
  // Box 2 left open: finishing is refused (its label isn't printed)
  await post('/api/pack/scan', { shipmentId: SID, boxNo: 2, code: 'TSTB', qty: 3 });
  const c1 = await post('/api/pack/box/close', { shipmentId: SID, boxNo: 1 });
  assert.strictEqual(c1.status, 200);
  assert.strictEqual(c1.body.barcode, 'AMZN,PO:FBAPACKTEST1,FNSKU:X00TESTAAA,QTY:4,FNSKU:X00TESTDUO,QTY:2');
  assert.strictEqual((await post('/api/pack/finish', { shipmentId: SID })).status, 409);
  // A closed box can't be scanned into
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 1, code: 'TSTA' })).status, 409);
  assert.strictEqual((await post('/api/pack/box/close', { shipmentId: SID, boxNo: 2 })).status, 200);
  // Nothing deducted until Finish
  assert.deepStrictEqual(await stock('TSTA'), A);
  const [f1, f2] = await Promise.all([post('/api/pack/finish', { shipmentId: SID }), post('/api/pack/finish', { shipmentId: SID })]);
  assert.deepStrictEqual([f1.status, f2.status].sort(), [200, 409]);
  // A: 4 singles + 2 in duos; B: 3 singles + 2 in duos
  assert.deepStrictEqual(await stock('TSTA'), { onhand: A.onhand - 6, transit: A.transit + 6 });
  assert.deepStrictEqual(await stock('TSTB'), { onhand: B.onhand - 5, transit: B.transit + 5 });
  // Stored as bottles, but each line remembers what it shipped as (single or the duo)
  const rows = (await pool.query(`SELECT asin, shipped_as, SUM(qty)::int AS q FROM inv_shipment_items WHERE shipment_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [SID])).rows;
  assert.deepStrictEqual(rows.map(r => [r.asin, r.shipped_as, r.q]), [['TSTA', 'TSTA', 4], ['TSTA', 'TSTDUO', 2], ['TSTB', 'TSTB', 3], ['TSTB', 'TSTDUO', 2]]);
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 3, code: 'TSTA' })).status, 409);
  assert.strictEqual((await post('/api/pack/finish', { shipmentId: SID })).status, 409);
  assert.deepStrictEqual(await stock('TSTA'), { onhand: A.onhand - 6, transit: A.transit + 6 });
});

test('pack boxes: a shipment already posted by pack slip is not deducted again', { skip }, async () => {
  const SID = 'FBAPACKTEST2';
  await post('/api/bulk-ship', { shipmentId: SID, items: [{ code: 'TSTA', qty: 1 }] });
  await post('/api/pack/start', { shipmentId: SID });
  await confirmDest(SID);
  await post('/api/pack/scan', { shipmentId: SID, boxNo: 1, code: 'TSTA', qty: 2 });
  await post('/api/pack/box/close', { shipmentId: SID, boxNo: 1 });
  const A = await stock('TSTA');
  const r = await post('/api/pack/finish', { shipmentId: SID });
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(await stock('TSTA'), A);
});

test('2D production delete: removes only the packing record, never stock', { skip }, async () => {
  // A shipment already deducted by pack slip, tested in 2D Production, then deleted
  const SID = 'FBAPACKTEST2';
  const A = await stock('TSTA');
  const posted = (await one('SELECT COALESCE(SUM(qty),0)::int AS n FROM inv_shipment_items WHERE shipment_id=$1', [SID])).n;
  const [d1, d2] = await Promise.all([post('/api/pack/delete', { shipmentId: SID }), post('/api/pack/delete', { shipmentId: SID })]);
  assert.deepStrictEqual([d1.status, d2.status].sort(), [200, 404]);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_pack_boxes WHERE shipment_id=$1', [SID])).n, 0);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_pack_shipments WHERE shipment_id=$1', [SID])).n, 0);
  assert.deepStrictEqual(await stock('TSTA'), A);
  assert.strictEqual((await one('SELECT COALESCE(SUM(qty),0)::int AS n FROM inv_shipment_items WHERE shipment_id=$1', [SID])).n, posted);
  // A finished one: its deduction stays
  const S1 = 'FBAPACKTEST1', before = await stock('TSTA');
  const r = await post('/api/pack/delete', { shipmentId: S1 });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.wasFinished, true);
  assert.deepStrictEqual(await stock('TSTA'), before);
  // Loading the same ID again starts clean
  assert.strictEqual((await post('/api/pack/start', { shipmentId: SID })).status, 200);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_pack_boxes WHERE shipment_id=$1', [SID])).n, 0);
});

test('Amazon re-created a shipment under a new ID: the record moves, stock is not deducted twice', { skip }, async () => {
  const OLD = 'FBAREPLOLD01', NEW = 'FBAREPLNEW01';
  await post('/api/receive', { asin: 'TSTA', qty: 20 });
  assert.strictEqual((await post('/api/bulk-ship', { shipmentId: OLD, items: [{ code: 'TSTA', qty: 5 }] })).status, 200);
  await post('/api/pack/start', { shipmentId: OLD });
  await confirmDest(OLD);
  assert.strictEqual((await post('/api/pack/boxes', { shipmentId: OLD, asin: 'TSTA', qtyPerBox: 5, count: 1, pallet: 1, unitWeight: 1, len: 10, wid: 10, hgt: 10 })).status, 200);
  const A = await stock('TSTA');
  // Staff can't do it
  assert.notStrictEqual((await post('/api/shipments/replace-id', { from: OLD, to: NEW })).status, 200);
  const [r1, r2] = await Promise.all([post('/api/shipments/replace-id', { from: OLD, to: NEW }, { owner: true }), post('/api/shipments/replace-id', { from: OLD, to: NEW }, { owner: true })]);
  assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 404]);
  assert.deepStrictEqual(await stock('TSTA'), A);   // no stock change
  assert.strictEqual((await one('SELECT COALESCE(SUM(qty),0)::int AS n FROM inv_shipment_items WHERE shipment_id=$1', [NEW])).n, 5);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_shipments WHERE shipment_id=$1', [OLD])).n, 0);
  assert.strictEqual((await one("SELECT status FROM inv_shipments WHERE shipment_id=$1", [NEW])).status, 'in_transit');
  // 2D Production followed it; the destination must be confirmed again before labels
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_pack_boxes WHERE shipment_id=$1', [NEW])).n, 1);
  assert.strictEqual((await one('SELECT dest_confirmed_at FROM inv_pack_shipments WHERE shipment_id=$1', [NEW])).dest_confirmed_at, null);
  // Posting the new ID's pack slip now is refused (already deducted)
  assert.strictEqual((await post('/api/bulk-ship', { shipmentId: NEW, items: [{ code: 'TSTA', qty: 5 }] })).status, 409);
  assert.deepStrictEqual(await stock('TSTA'), A);
});

test('a cancelled shipment with no replacement: deleted once, units back on hand', { skip }, async () => {
  const SID = 'FBACANCEL001';
  const A0 = await stock('TSTA'), B0 = await stock('TSTB');
  await post('/api/bulk-ship', { shipmentId: SID, items: [{ code: 'TSTA', qty: 2 }, { code: 'TSTDUO', qty: 1 }] });
  assert.deepStrictEqual(await stock('TSTA'), { onhand: A0.onhand - 3, transit: A0.transit + 3 });
  const [c1, c2] = await Promise.all([post('/api/shipments/cancel', { shipmentId: SID }, { owner: true }), post('/api/shipments/cancel', { shipmentId: SID }, { owner: true })]);
  assert.deepStrictEqual([c1.status, c2.status].sort(), [200, 404]);
  assert.deepStrictEqual(await stock('TSTA'), A0);
  assert.deepStrictEqual(await stock('TSTB'), B0);
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_shipments WHERE shipment_id=$1', [SID])).n, 0);
});

test('shipment created from the app: boxes take Amazon\'s box numbers; two taps can\'t take the same boxes', { skip }, async () => {
  const SID = 'FBAAPPPLAN01';
  const plan = [1, 2, 3].map(n => ({ box_no: n, items: [{ msku: 'SKU-A', asin: 'TSTA', qty: 6 }] })).concat([{ box_no: 4, items: [{ msku: 'SKU-B', asin: 'TSTB', qty: 6 }] }]);
  await pool.query(`INSERT INTO inv_pack_shipments(shipment_id, name, dest_confirmed_at, amz_boxes) VALUES($1,'app plan',now(),$2)`, [SID, JSON.stringify(plan)]);
  const mk = (asin, per, count) => post('/api/pack/boxes', { shipmentId: SID, asin, qtyPerBox: per, count, pallet: 1, unitWeight: 1, len: 10, wid: 10, hgt: 10, override: true });
  const b = await mk('TSTB', 6, 1);
  assert.strictEqual(b.status, 200); assert.deepStrictEqual(b.body.boxes, [4]);
  // 3 boxes of A in the plan: two simultaneous requests for 2 each → one gets 2, the other is refused
  const [r1, r2] = await Promise.all([mk('TSTA', 6, 2), mk('TSTA', 6, 2)]);
  assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.deepStrictEqual((r1.status === 200 ? r1 : r2).body.boxes, [1, 2]);
  assert.strictEqual((await mk('TSTA', 12, 1)).status, 409);   // not in Amazon's plan at 12 per box
  assert.deepStrictEqual((await mk('TSTA', 6, 1)).body.boxes, [3]);
  assert.strictEqual((await post('/api/pack/scan', { shipmentId: SID, boxNo: 9, code: 'TSTA' })).status, 409);   // no mixed boxes
  assert.strictEqual((await one('SELECT COUNT(*)::int AS n FROM inv_pack_boxes WHERE shipment_id=$1', [SID])).n, 4);
});

test('expiration on a box follows the date Amazon has for the product', { skip }, async () => {
  const SID = 'FBAEXPTEST1';
  await post('/api/pack/start', { shipmentId: SID });
  await confirmDest(SID);
  // Amazon's shipment says TSTA expires 2029-07-12 (the plan's date).
  await pool.query(`UPDATE inv_pack_shipments SET amz = $2 WHERE shipment_id=$1`,
    [SID, JSON.stringify({ items: [{ asin: 'TSTA', msku: 'SKU-A', fnsku: 'X00TESTAAA', qty: 20, expiration: '2029-07-12T00:00Z' }] })]);
  // The floor typed a different date: the box takes Amazon's.
  const r = await post('/api/pack/boxes', { shipmentId: SID, asin: 'TSTA', qtyPerBox: 10, count: 1, pallet: 1, unitWeight: 1, len: 10, wid: 10, hgt: 10, exp: '09/23/2029' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const b1 = await one('SELECT exp, items FROM inv_pack_boxes WHERE shipment_id=$1 AND box_no=1', [SID]);
  assert.strictEqual(b1.exp, '290712');
  assert.strictEqual(b1.items[0].exp, '290712');
});

test('2D production: N identical boxes, pallet limit refused unless overridden, numbers stay 1..N', { skip }, async () => {
  const SID = 'FBAPACKTEST3';
  await post('/api/pack/start', { shipmentId: SID });
  const mk = (count, extra) => post('/api/pack/boxes', Object.assign({ shipmentId: SID, asin: 'TSTDUO', qtyPerBox: 6, count, pallet: 1, unitWeight: 5, len: 12, wid: 12, hgt: 12 }, extra || {}));
  // No labels before the destination is confirmed
  assert.strictEqual((await mk(1)).status, 409);
  await confirmDest(SID);
  const a = await mk(10);
  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.deepStrictEqual(a.body.boxes, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.strictEqual(a.body.weight, 30);   // 6 × 5 lb
  // Remembered for next time
  const p = await one(`SELECT case_qty, case_len::float AS l, unit_weight_lb::float AS w, unit_weight_src FROM inv_products WHERE asin='TSTDUO'`);
  assert.deepStrictEqual(p, { case_qty: 6, l: 12, w: 5, unit_weight_src: 'manual' });
  // Pallet 1: 100 lb allowance + 10 × 30 = 400 lb. 60 more boxes (1,800 lb) won't fit.
  const big = await mk(60);
  assert.strictEqual(big.status, 409);
  assert.strictEqual(big.body.error, 'pallet_full');
  assert.ok(big.body.fits > 0 && big.body.fits < 60);
  assert.strictEqual((await one(`SELECT COUNT(*)::int AS n FROM inv_pack_boxes WHERE shipment_id=$1`, [SID])).n, 10);
  // Void box 4: the next box takes number 4, so Amazon's 1..N still lines up
  assert.strictEqual((await post('/api/pack/box/void', { shipmentId: SID, boxNo: 4 })).status, 200);
  assert.deepStrictEqual((await mk(2)).body.boxes, [4, 11]);
  // Going over on purpose, on a new pallet, is allowed
  const over = await mk(big.body.fits + 1, { pallet: 2, override: true });
  assert.strictEqual(over.status, 200);
});

test('staff cannot reach owner routes', { skip }, async () => {
  // Capacity room left is cubic feet only; the owner dropped the password there (#132)
  assert.notStrictEqual((await post('/api/capacity/limit', { standard: 1 })).status, 403);
  assert.strictEqual((await fetch(`http://localhost:${PORT}/api/backup/download`, { headers: H() })).status, 403);
  assert.strictEqual((await fetch(`http://localhost:${PORT}/api/plan/data`, { headers: H() })).status, 403);
});

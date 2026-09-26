#!/usr/bin/env node
// ============================================================
// RESTORE a backup made by the app (Admin → Data Sources → Download backup,
// or the Sunday backup email) into a database.
//
//   1. Point DATABASE_URL at the database to restore into. For a real
//      recovery on Railway, that's a NEW Postgres service, not the broken one.
//   2. Start the app against it once (npm start) so it creates every table,
//      then stop it.
//   3. node scripts/restore-backup.js elevate-backup-2026-09-27.json.gz --yes
//
// Every table in the backup is EMPTIED and refilled from the file, in one
// transaction: if anything fails, nothing changes. Tables the backup doesn't
// have are left alone. Without --yes it only prints what it would do.
// ============================================================
const fs = require('fs');
const zlib = require('zlib');
const { Pool } = require('pg');

(async () => {
  const file = process.argv[2], go = process.argv.includes('--yes');
  if (!file || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=... node scripts/restore-backup.js <backup.json.gz> [--yes]'); process.exit(1); }
  const raw = fs.readFileSync(file);
  const data = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
  if (data.app !== 'elevate-inventory' || !data.tables) { console.error('Not an Elevate Inventory backup.'); process.exit(1); }
  const names = Object.keys(data.tables);
  console.log(`Backup from ${data.at} (build ${data.build}): ${names.length} tables.`);
  for (const n of names) console.log(`  ${n}: ${data.tables[n].length} rows`);
  if (!go) { console.log('\nDry run. Add --yes to restore (this EMPTIES those tables first).'); return; }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /railway/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false });
  const db = await pool.connect();
  try {
    const have = new Set((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(r => r.table_name));
    const missing = names.filter(n => !have.has(n));
    if (missing.length) throw new Error('These tables do not exist yet — start the app once against this database first: ' + missing.join(', '));
    // Parents before the tables that point at them.
    const first = ['inv_products', 'inv_invoices', 'inv_shipments', 'inv_employees'];
    const order = first.filter(n => names.includes(n)).concat(names.filter(n => !first.includes(n)).sort());
    await db.query('BEGIN');
    await db.query(`TRUNCATE ${order.map(n => `"${n}"`).join(', ')} CASCADE`);
    for (const n of order) {
      const rows = data.tables[n];
      for (let i = 0; i < rows.length; i += 500) {   // chunks keep each statement a sane size
        await db.query(`INSERT INTO "${n}" SELECT * FROM json_populate_recordset(NULL::"${n}", $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
      }
    }
    // SERIAL ids carry on after the highest restored id.
    const seqs = await db.query(`SELECT c.table_name, c.column_name, pg_get_serial_sequence('"' || c.table_name || '"', c.column_name) AS seq
      FROM information_schema.columns c WHERE c.table_schema='public' AND c.column_default LIKE 'nextval(%'`);
    for (const r of seqs.rows) if (r.seq && names.includes(r.table_name)) {
      await db.query(`SELECT setval($1, COALESCE((SELECT MAX("${r.column_name}") FROM "${r.table_name}"), 0) + 1, false)`, [r.seq]);
    }
    await db.query('COMMIT');
    console.log('Restored.');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('Restore FAILED, nothing changed:', e.message);
    process.exitCode = 1;
  } finally { db.release(); await pool.end(); }
})();

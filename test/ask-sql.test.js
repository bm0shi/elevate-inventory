const test = require('node:test');
const assert = require('node:assert');
const { checkSql, wrapLimit, rowsText } = require('../lib/ask-sql');

test('only one SELECT runs; a ; inside a string is fine', () => {
  assert.strictEqual(checkSql('SELECT 1;').ok, true);
  assert.strictEqual(checkSql("with x as (select 1) select * from x").ok, true);
  assert.strictEqual(checkSql("SELECT name FROM inv_products WHERE name ILIKE '%a;b%'").ok, true);
  assert.strictEqual(checkSql('SELECT 1; DROP TABLE inv_products').ok, false);
  assert.strictEqual(checkSql('DELETE FROM inv_stock').ok, false);
  assert.strictEqual(checkSql('UPDATE inv_stock SET onhand=0').ok, false);
  assert.strictEqual(checkSql('SELECT 1 -- hi').ok, false);
});

test('server-file and sleep functions are refused, words in data are not', () => {
  assert.strictEqual(checkSql("SELECT pg_read_file('/etc/passwd')").ok, false);
  assert.strictEqual(checkSql('SELECT pg_sleep(100)').ok, false);
  assert.strictEqual(checkSql("SELECT * FROM inv_products WHERE name ILIKE '%copy%'").ok, true);
  assert.strictEqual(checkSql("SELECT * FROM inv_products WHERE name ILIKE '%Gift Set%'").ok, true);
});

test('row cap wraps the query; rows become compact lines and get cut', () => {
  assert.strictEqual(wrapLimit('SELECT 1', 201), 'SELECT * FROM (SELECT 1) AS q LIMIT 201');
  const t = rowsText([{ a: 1.23456, d: new Date('2026-10-01T00:00:00Z'), n: '12.34567' }]);
  assert.strictEqual(t, '{"a":1.23,"d":"2026-10-01","n":12.35}');
  assert.match(rowsText(Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(100) })), 500), /more rows cut/);
});

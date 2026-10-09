const test = require('node:test');
const assert = require('node:assert');
const { parseReturns } = require('../lib/returns');

test('returns: one record per returned line, repeats across windows counted once', () => {
  const H = 'return-date\torder-id\tsku\tasin\tfnsku\tproduct-name\tquantity\tfulfillment-center-id\tdetailed-disposition\treason\tstatus\tlicense-plate-number\tcustomer-comments';
  const a = [H, '2026-10-01T10:00:00+00:00\t111\tS1\tB1\tX1\tShampoo\t1\tPHX3\tSELLABLE\tUNWANTED_ITEM\tUnit returned to inventory\tLPN1\t',
                '2026-10-02T10:00:00+00:00\t222\tS2\tB2\tX2\tCond\t2\tPHX3\tCUSTOMER_DAMAGED\tDAMAGED_BY_CARRIER\tReimbursed\tLPN2\tleaked'].join('\n');
  const b = [H, '2026-10-02T10:00:00+00:00\t222\tS2\tB2\tX2\tCond\t2\tPHX3\tCUSTOMER_DAMAGED\tDAMAGED_BY_CARRIER\tReimbursed\tLPN2\tleaked'].join('\n');
  const r = parseReturns([a, b]);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r.reduce((t, x) => t + x.qty, 0), 3);
  assert.deepStrictEqual([r[1].asin, r[1].reason, r[1].disposition], ['B2', 'DAMAGED_BY_CARRIER', 'CUSTOMER_DAMAGED']);
});

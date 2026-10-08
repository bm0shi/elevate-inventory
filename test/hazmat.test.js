const test = require('node:test');
const assert = require('node:assert');
const { fromDeclared, fromEligibility, combine } = require('../lib/hazmat');

test('eligibility: Amazon sends codes, not words — 0016 is hazmat', () => {
  // The old scan searched for "HAZMAT" in these and never matched a code.
  const r = fromEligibility({ asin: 'B000000001', isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0016'] });
  assert.strictEqual(r.hazmat, true);
  assert.match(r.detail, /FBA_INB_0016/);
});

test('eligibility: under hazmat review counts as hazmat; other reasons say nothing', () => {
  assert.strictEqual(fromEligibility({ isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0014'] }).hazmat, true);
  // no SKU on our account / missing dimensions: not a hazmat answer
  assert.strictEqual(fromEligibility({ isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0006', 'FBA_INB_0004'] }).hazmat, null);
  assert.strictEqual(fromEligibility({ isEligibleForProgram: true }).hazmat, false);
  assert.strictEqual(fromEligibility(null).hazmat, null);
});

test('declared: "unknown" stays unknown (used to be read as HAZMAT)', () => {
  assert.strictEqual(fromDeclared({ supplier_declared_dg_hz_regulation: [{ value: 'unknown' }] }).hazmat, null);
  assert.strictEqual(fromDeclared({ supplier_declared_dg_hz_regulation: [{ value: 'not_applicable' }] }).hazmat, false);
  assert.strictEqual(fromDeclared({ supplier_declared_dg_hz_regulation: [{ value: 'ghs' }] }).hazmat, true);
  assert.strictEqual(fromDeclared({ supplier_declared_dg_hz_regulation: [{ value: 'unknown' }, { value: 'transportation' }] }).hazmat, true);
  assert.strictEqual(fromDeclared({}).hazmat, null);
});

test('combine: Amazon hazmat code outranks a clean declaration; declaration fills in', () => {
  const clean = fromDeclared({ supplier_declared_dg_hz_regulation: [{ value: 'not_applicable' }] });
  const haz = fromEligibility({ isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0016'] });
  const silent = fromEligibility({ isEligibleForProgram: false, ineligibilityReasonList: ['FBA_INB_0006'] });
  assert.deepStrictEqual([combine(clean, haz).hazmat, combine(clean, haz).source], [true, 'amazon-inbound']);
  assert.deepStrictEqual([combine(clean, silent).hazmat, combine(clean, silent).source], [false, 'amazon-dg']);
  assert.strictEqual(combine(fromDeclared({}), silent).hazmat, null);
  assert.strictEqual(combine(null, null).hazmat, null);
});

const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/invoice-parts');

const BASE = '262106088';
const L1 = [{ cosmo_num: '573244', qty_shipped: 1322 }];
const L2 = [{ cosmo_num: '573244', qty_shipped: 678 }];

test('first delivery is the invoice itself; a later slip after check-in becomes -2, then -3', () => {
  assert.deepStrictEqual(P.planInvoiceWrite({ base: BASE, key: '262100001', sig: P.lineSig(L1), parts: [] }),
    { write: true, orderNumber: BASE, mode: 'create' });
  const parts = [{ order_number: BASE, status: 'received', slips: ['262100001'], sig: P.lineSig(L1) }];
  assert.deepStrictEqual(P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts }),
    { write: true, orderNumber: BASE + '-2', mode: 'create' });
  parts.push({ order_number: BASE + '-2', status: 'received', slips: ['262114389'], sig: P.lineSig(L2) });
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '262199999', sig: 'x', parts }).orderNumber, BASE + '-3');
});

test('each slip number is its own invoice, even while an earlier one waits to be checked in', () => {
  const parts = [{ order_number: BASE, status: 'pending', slips: ['262100001'], sig: P.lineSig(L1) }];
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts }).orderNumber, BASE + '-2');
});

test('the same slip twice: refused once checked in, a correction before', () => {
  const parts = [{ order_number: BASE + '-2', status: 'received', slips: ['262114389'], sig: P.lineSig(L2) },
                 { order_number: BASE, status: 'received', slips: ['262100001'], sig: P.lineSig(L1) }];
  const r = P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts });
  assert.deepStrictEqual(r, { write: false, orderNumber: BASE + '-2', why: 'already' });
  assert.match(P.refusalText(r, BASE, '262114389'), /already added as #262106088-2/);
  parts[0].status = 'pending';
  assert.deepStrictEqual(P.planInvoiceWrite({ base: BASE, key: '262114389', sig: 'changed', parts }),
    { write: true, orderNumber: BASE + '-2', mode: 'replace' });
});

test('older rows without a slip number: identical lines are the same slip; different lines are a new delivery', () => {
  const parts = [{ order_number: BASE, status: 'received', slips: null, sig: P.lineSig(L1) }];
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '262100001', sig: P.lineSig(L1), parts }).why, 'same_lines');
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '', sig: P.lineSig(L1), parts }).why, 'same_lines');
  // the owner's case: checked in short, the rest pasted a week later
  assert.deepStrictEqual(P.planInvoiceWrite({ base: BASE, key: '', sig: P.lineSig(L2), parts }),
    { write: true, orderNumber: BASE + '-2', mode: 'create' });
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts }).orderNumber, BASE + '-2');
});

test('text without a slip number replaces an invoice not yet checked in (fixing a paste); a slip never guesses into one', () => {
  const parts = [{ order_number: BASE, status: 'pending', slips: null, sig: P.lineSig(L1) }];
  assert.deepStrictEqual(P.planInvoiceWrite({ base: BASE, key: '', sig: P.lineSig(L2), parts }),
    { write: true, orderNumber: BASE, mode: 'replace' });
  const r = P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts });
  assert.deepStrictEqual(r, { write: false, orderNumber: BASE, why: 'pending_unkeyed' });
  assert.match(P.refusalText(r, BASE, '262114389'), /Check it in first/);
});

test('sig ignores line order; part numbers read back', () => {
  assert.strictEqual(P.lineSig([{ cosmo_num: 'b', qty_shipped: 1 }, { cosmo_num: 'a', qty_shipped: 2 }]),
    P.lineSig([{ cosmo_num: 'a', qty_expected: 2 }, { cosmo_num: 'b', qty_expected: 1 }]));
  assert.strictEqual(P.partNo('262106088-12', BASE), 12);
  assert.strictEqual(P.partNo(BASE, BASE), 1);
});

test('a later delivery takes its units off what earlier parts were short, oldest first, never below zero', () => {
  const owed = [{ id: 1, cosmo_num: '573244', qty_owed: 500 }, { id: 2, cosmo_num: '573244', qty_owed: 400 }, { id: 3, cosmo_num: '575394', qty_owed: 0 }];
  assert.deepStrictEqual(P.owedTakeoff(owed, [{ cosmo_num: '573244', qty: 678 }, { cosmo_num: '575394', qty: 10 }]),
    [{ id: 1, take: 500 }, { id: 2, take: 178 }]);
  assert.deepStrictEqual(P.owedTakeoff(owed, [{ cosmo_num: '999999', qty: 5 }]), []);
});

test('an emailed invoice holding two shipments: a paper slip for either one is already in', () => {
  const parts = [{ order_number: BASE, status: 'received', slips: ['262100001', '262114389'], sig: 'whole' }];
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, key: '262114389', sig: P.lineSig(L2), parts }).why, 'already');
  assert.strictEqual(P.planInvoiceWrite({ base: BASE, keys: ['262199999', '262100001'], sig: 'x', parts }).why, 'already');
});

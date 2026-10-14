const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/invoice-photo');

// What Claude read from the owner's three phone scans of 10/09/2026
const read = { slips: [
  { invoice_number: '262123863', invoice_date: '10/09/2026', shipment_number: '262135324', part_of_multiple: true, unclear: '',
    lines: [{ sku: '575394', description: 'PM TEA TREE GROOMING POMADE 3 OZ', qty_ordered: 120, qty_shipped: 36, each_price: 12.38, extended_price: 445.68 }] },
  { invoice_number: '262123863', invoice_date: '10/09/2026', shipment_number: '262131920', part_of_multiple: true, unclear: '',
    lines: [{ sku: '037622', description: 'PM TEA TREE FORMING CREAM 3 OZ', qty_ordered: 120, qty_shipped: 60, each_price: 12.38, extended_price: 742.80 }] },
  { invoice_number: '262124040', invoice_date: '10/09/2026', shipment_number: '262130159', part_of_multiple: false, unclear: 'page folded through the description',
    lines: [{ sku: '573055', description: 'PM 6% EXTRA BODY SCULPTING FOAM 6.7 OZ', qty_ordered: 60, qty_shipped: 60, each_price: 8.55, extended_price: 513.00 }] },
] };

test('slips of one invoice merge into one order; each slip keeps its own lines; dates and SKUs normalised', () => {
  const r = P.toInvoices(read);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.invoices.length, 2);
  const a = r.invoices.find(i => i.orderNumber === '262123863');
  assert.strictEqual(a.date, '10/9/26');
  assert.deepStrictEqual(a.slips, ['262135324', '262131920']);
  assert.deepStrictEqual(a.items.map(i => [i.cosmo_num, i.qty_shipped, i.unit_cost]), [['575394', 36, 12.38], ['037622', 60, 12.38]]);
  const b = r.invoices.find(i => i.orderNumber === '262124040');
  assert.match(b.warnings[0], /folded/);
  assert.strictEqual(P.sku('37622'), '037622');   // a dropped leading zero comes back
});

test('a misread digit is flagged (shipped × each ≠ extended); unreadable lines are not added; the same slip twice counts once', () => {
  const r = P.toInvoices({ slips: [
    { invoice_number: '262123863', invoice_date: '10/09/2026', shipment_number: '1', part_of_multiple: true, unclear: '',
      lines: [{ sku: '575394', description: 'POMADE', qty_ordered: 120, qty_shipped: 38, each_price: 12.38, extended_price: 445.68 },
              { sku: '5?', description: 'SOMETHING', qty_ordered: 1, qty_shipped: 1, each_price: 1, extended_price: 1 }] },
    { invoice_number: '262123863', invoice_date: '10/09/2026', shipment_number: '1', part_of_multiple: true, unclear: '',
      lines: [{ sku: '575394', description: 'POMADE', qty_ordered: 120, qty_shipped: 38, each_price: 12.38, extended_price: 445.68 }] },
  ] });
  const a = r.invoices[0];
  assert.strictEqual(a.items.length, 1);
  assert.strictEqual(a.items[0].qty_shipped, 38);   // not 76
  assert.ok(a.warnings.some(w => /38 shipped doesn't match/.test(w) && !/\$/.test(w)));
  assert.ok(a.warnings.some(w => /couldn't be read/.test(w)));
  assert.match(P.toInvoices({ slips: [] }).problems[0], /No invoice/);
});

test('adding slips to an order: earlier slips stay, a slip added before is skipped, only new slips add lines', () => {
  const inv = P.toInvoices(read).invoices.find(i => i.orderNumber === '262123863');
  const first = P.mergeSlips([], [], Object.assign({}, inv, { slips: ['262135324'] }));
  assert.deepStrictEqual(first.items.map(i => [i.cosmo_num, i.qty_shipped]), [['575394', 36]]);
  const again = P.mergeSlips(first.items, first.slips, inv);
  assert.deepStrictEqual(again.skipped, ['262135324']);
  assert.deepStrictEqual(again.added, ['262131920']);
  assert.deepStrictEqual(again.items.map(i => [i.cosmo_num, i.qty_shipped]), [['575394', 36], ['037622', 60]]);
  const third = P.mergeSlips(again.items, again.slips, inv);
  assert.deepStrictEqual(third.added, []);
  assert.deepStrictEqual(third.items.map(i => i.qty_shipped), [36, 60]);
});

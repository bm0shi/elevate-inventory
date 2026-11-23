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

test('each slip keeps its own lines, so it can be saved as its own delivery', () => {
  const inv = P.toInvoices(read).invoices.find(i => i.orderNumber === '262123863');
  assert.deepStrictEqual(inv.slips, ['262135324', '262131920']);
  assert.deepStrictEqual(inv.bySlip['262135324'].map(i => [i.cosmo_num, i.qty_shipped]), [['575394', 36]]);
  assert.deepStrictEqual(inv.bySlip['262131920'].map(i => [i.cosmo_num, i.qty_shipped]), [['037622', 60]]);
});

// Other suppliers (owner 11/23): AII's packing slip for a Pro Beauty Shops order.
test('another supplier: its own keyed item / order numbers, backorders kept apart, Cosmoprof unchanged', () => {
  const P = require('../lib/invoice-photo');
  assert.equal(P.supplierKey('Cosmoprof'), null);
  assert.equal(P.supplierKey(' cosmo prof '), null);
  assert.equal(P.supplierKey('AII'), 'AII');
  assert.equal(P.supplierKey('Pro Beauty Shops'), 'PROBEAUTYSHOPS');
  const slip = { documents: [{ supplier_name: 'American International Industries', document_type: 'packing slip', document_number: '006819282-1', date: '11/20/2026', shipment_number: '', unclear: '', lines: [
    { item_number: '67867', upc: '', description: 'HF 1PR SIZE 2 COVERUPS LI', qty_ordered: 112, qty_backordered: 0, qty_shipped: 112, each_price: 0, extended_price: 0 },
    { item_number: '277000EC', upc: '', description: 'CL 4oz PWDR ORIGINAL', qty_ordered: 312, qty_backordered: 275, qty_shipped: 37, each_price: 0, extended_price: 0 },
    { item_number: '61010', upc: '0-74764-61567-1', description: 'ARD LASH 1PR NATURAL 110', qty_ordered: 112, qty_backordered: 0, qty_shipped: 112, each_price: 1.99, extended_price: 222.88 },
    { item_number: '99999', upc: '', description: 'ALL BACKORDERED', qty_ordered: 10, qty_backordered: 10, qty_shipped: 0, each_price: 0, extended_price: 0 },
  ] }] };
  const r = P.toInvoicesAny(slip, 'AII');
  assert.equal(r.invoices.length, 1);
  const inv = r.invoices[0];
  assert.equal(inv.orderNumber, 'AII-006819282-1');
  assert.equal(inv.date, '11/20/26');
  assert.deepEqual(inv.items.map(i => [i.cosmo_num, i.qty_shipped, i.qty_ordered]), [['AII:67867', 112, 112], ['AII:277000EC', 37, 312], ['AII:61010', 112, 112]]);
  assert.equal(inv.items[0].unit_cost, null, 'a packing slip has no prices');
  assert.equal(inv.items[2].unit_cost, 1.99);
  assert.equal(inv.items[2].upc, '074764615671');
  assert.deepEqual(inv.backordered.map(b => [b.item, b.qty]), [['277000EC', 275], ['99999', 10]]);
  assert.equal(P.itemShown('AII:277000EC'), '277000EC');
  assert.equal(P.itemShown('037622'), '037622');
  // the Cosmoprof reader still pads a dropped zero; the AII number above stays 67867
  assert.equal(P.sku('67867'), '067867');
});

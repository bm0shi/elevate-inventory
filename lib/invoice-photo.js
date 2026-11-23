// ============================================================
// SNAP AN INVOICE — Cosmoprof paper slips read from a photo or a scanned PDF
// (Order Check-In). Phone scans have no text inside, so the PDF readers found
// nothing (owner: "PDFs still not working in order check in"). Claude reads
// the picture (server.js /api/invoices/read-photo) into SCHEMA; this file
// checks and shapes what came back. No database, no API calls.
//
// A split shipment comes as several slips for the SAME invoice number, each
// with its own SHP# (shipment number). bySlip keeps each slip's lines: every
// slip is saved as its own delivery (lib/invoice-parts.js), and the SHP# stops
// a slip being added twice.
// ============================================================

// What Claude returns (structured output). No nulls: "" / 0 mean "couldn't read".
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['slips'],
  properties: {
    slips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['invoice_number', 'invoice_date', 'shipment_number', 'part_of_multiple', 'lines', 'unclear'],
        properties: {
          invoice_number: { type: 'string', description: 'The number after "Invoice" (top right), digits only, e.g. 262123863' },
          invoice_date: { type: 'string', description: 'The date printed top left, as printed, e.g. 10/09/2026' },
          shipment_number: { type: 'string', description: 'The number after SHP#, digits only; "" if none' },
          part_of_multiple: { type: 'boolean', description: 'true if the slip says it is part of a multiple shipment' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sku', 'description', 'qty_ordered', 'qty_shipped', 'each_price', 'extended_price'],
              properties: {
                sku: { type: 'string', description: 'SKU Number column, digits exactly as printed incl. leading zeros' },
                description: { type: 'string', description: 'Description column including the size, e.g. PM TEA TREE GROOMING POMADE 3 OZ' },
                qty_ordered: { type: 'integer' },
                qty_shipped: { type: 'integer', description: 'Qty Shipped column (the printed number, not handwriting)' },
                each_price: { type: 'number' },
                extended_price: { type: 'number' },
              },
            },
          },
          unclear: { type: 'string', description: 'Anything that could not be read with certainty (torn, folded, blurred); "" if all clear' },
        },
      },
    },
  },
};

const PROMPT = `These are photos or scans of Cosmoprof paper invoices / shipment slips (one or more pages, possibly folded, torn or at an angle).
Read every slip. For each, copy the invoice number, the printed date, the SHP# shipment number, whether it says it is part of a multiple shipment, and every item line (SKU number, description with size, qty ordered, qty shipped, each price, extended price).
Copy numbers exactly as printed; keep leading zeros in SKU numbers. Ignore handwriting, circles and check marks. Do not guess a digit you cannot read: put what you can see and say what is unclear in "unclear".`;

const digits = (s) => String(s == null ? '' : s).replace(/\D/g, '');
// "10/09/2026" or "10/9/26" → "10/9/26" (the app's invoice date format, like findInvoiceDate)
function shortDate(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(String(s || ''));
  if (!m) return '';
  return (+m[1]) + '/' + (+m[2]) + '/' + m[3].slice(-2);
}
// Cosmo item numbers are 6 digits ("037622"); a dropped leading zero is put back.
function sku(s) {
  const d = digits(s);
  return d.length === 5 ? '0' + d : d;
}

// → { invoices: [{ orderNumber, date, slips:[shp], items:[{cosmo_num, description, qty_shipped, unit_cost}], warnings:[] }], problems: [] }
function toInvoices(result) {
  const byOrder = new Map(), problems = [];
  const slips = (result && Array.isArray(result.slips)) ? result.slips : [];
  if (!slips.length) problems.push('No invoice could be read from this file.');
  const seenSlip = new Set();
  for (const s of slips) {
    const orderNumber = digits(s.invoice_number);
    if (orderNumber.length < 6) { problems.push(`A slip's invoice number couldn't be read ("${String(s.invoice_number || '').slice(0, 20)}").`); continue; }
    const shp = digits(s.shipment_number);
    const lines = Array.isArray(s.lines) ? s.lines : [];
    // the same slip photographed twice: once only
    const slipKey = shp || ('noshp:' + lines.map(l => sku(l.sku) + 'x' + (l.qty_shipped | 0)).join(','));
    if (seenSlip.has(orderNumber + '|' + slipKey)) continue;
    seenSlip.add(orderNumber + '|' + slipKey);
    const inv = byOrder.get(orderNumber) || { orderNumber, date: '', slips: [], items: [], bySlip: {}, warnings: [] };
    byOrder.set(orderNumber, inv);
    if (!inv.date) inv.date = shortDate(s.invoice_date);
    inv.slips.push(slipKey);
    const own = inv.bySlip[slipKey] = [];
    if (s.unclear && String(s.unclear).trim()) inv.warnings.push((shp ? 'Slip ' + shp + ': ' : '') + String(s.unclear).trim().slice(0, 200));
    for (const l of lines) {
      const c = sku(l.sku), q = parseInt(l.qty_shipped, 10), each = Number(l.each_price), ext = Number(l.extended_price);
      const desc = String(l.description || '').trim().slice(0, 120);
      if (c.length < 5 || c.length > 7) { inv.warnings.push(`"${desc || 'a line'}": item number "${String(l.sku || '').slice(0, 12)}" couldn't be read — add that line by hand.`); continue; }
      if (!(q >= 0)) { inv.warnings.push(`${c} ${desc}: quantity shipped couldn't be read — add that line by hand.`); continue; }
      // the numbers have to add up: shipped × each = extended (a misread digit shows here)
      // (no prices in the words: staff see these warnings, and cost is owner-only)
      if (q > 0 && each > 0 && ext > 0 && Math.abs(q * each - ext) > 0.05) inv.warnings.push(`${c} ${desc}: ${q} shipped doesn't match the line's price total — check the quantity against the paper.`);
      if (q === 0) continue;   // backordered, nothing in this box
      const o = parseInt(l.qty_ordered, 10);
      const line = { cosmo_num: c, description: desc, qty_ordered: o >= q ? o : null, qty_shipped: q, unit_cost: each > 0 ? Math.round(each * 100) / 100 : null };
      own.push(Object.assign({}, line));
      const prev = inv.items.find(i => i.cosmo_num === c);
      if (prev) { prev.qty_shipped += q; prev.qty_ordered = prev.qty_ordered != null && line.qty_ordered != null ? prev.qty_ordered + line.qty_ordered : null; }
      else inv.items.push(line);
    }
  }
  return { invoices: [...byOrder.values()], problems };
}

// ============================================================
// OTHER SUPPLIERS (owner 11/23: "since we're trying different brands from
// different suppliers, our invoice upload needs to know that not all invoices
// are from Cosmoprof"; the first was AII's packing slip for a Pro Beauty Shops
// order). Each invoice has a supplier; blank = Cosmoprof, read exactly as
// above. Another supplier's item numbers and order numbers are kept under its
// own key, "AII:67867" and "AII-006819282-1", so they never meet a Cosmoprof
// number: the Cosmoprof reader would have turned AII's 67867 into Cosmoprof's
// 067867 (sku() pads 5 digits) and linked it to the wrong product. Everything
// downstream (links, barcode check, shortages) works on those keys unchanged.
// ============================================================
// "Pro Beauty Shops" → "PROBEAUTYSHOPS"; Cosmoprof (any spelling) → null
function supplierKey(name) {
  const k = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return !k || k === 'COSMOPROF' || k === 'COSMOPROFBEAUTY' ? null : k;
}
const itemCode = (key, item) => {
  const v = String(item == null ? '' : item).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 30);
  return v ? (key ? key + ':' + v : v) : '';
};
const orderCode = (key, num) => {
  const v = String(num == null ? '' : num).toUpperCase().replace(/[^A-Z0-9\-]/g, '').replace(/^-+|-+$/g, '').slice(0, 30);
  return v ? (key ? key + '-' + v : v) : '';
};
// What's shown: the supplier's own item number, without the key.
const itemShown = (code) => { const s = String(code || ''); const i = s.indexOf(':'); return i > 0 ? s.slice(i + 1) : s; };

const SCHEMA_ANY = {
  type: 'object',
  additionalProperties: false,
  required: ['documents'],
  properties: {
    documents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['supplier_name', 'document_type', 'document_number', 'date', 'shipment_number', 'lines', 'unclear'],
        properties: {
          supplier_name: { type: 'string', description: 'The company that sent the goods, as printed (logo / letterhead)' },
          document_type: { type: 'string', description: 'invoice, packing slip, order confirmation …' },
          document_number: { type: 'string', description: 'The invoice or order number as printed, incl. any suffix like -1' },
          date: { type: 'string', description: 'The ship / invoice date as printed, e.g. 11/20/2026' },
          shipment_number: { type: 'string', description: 'A separate shipment / tracking number for this box, "" if none' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['item_number', 'upc', 'description', 'qty_ordered', 'qty_backordered', 'qty_shipped', 'each_price', 'extended_price'],
              properties: {
                item_number: { type: 'string', description: 'The supplier\'s item / SKU number exactly as printed (letters kept)' },
                upc: { type: 'string', description: 'A 12-14 digit UPC / EAN if printed on the line, "" if none' },
                description: { type: 'string', description: 'The item description as printed, including the size or pack' },
                qty_ordered: { type: 'integer', description: '0 if the document has no ordered column' },
                qty_backordered: { type: 'integer', description: 'Backordered / B/O, often shown in <angle brackets>; 0 if none' },
                qty_shipped: { type: 'integer', description: 'Shipped quantity (what is in this delivery and billed)' },
                each_price: { type: 'number', description: 'Unit price; 0 if the document has no prices (a packing slip)' },
                extended_price: { type: 'number', description: 'Line total; 0 if none' },
              },
            },
          },
          unclear: { type: 'string', description: 'Anything that could not be read with certainty; "" if all clear' },
        },
      },
    },
  },
};
const promptAny = (supplier) => `These are photos or scans of a supplier's invoice or packing slip (supplier: ${String(supplier || 'unknown').slice(0, 60)}), one or more pages.
Read every document. For each, copy the supplier name, what kind of document it is, its invoice or order number, its date, any shipment number, and every item line: the supplier's item number, a UPC if one is printed, the description with size, qty ordered, qty backordered, qty shipped, unit price and line total.
Lot numbers, lot quantities, weights and box counts are not item lines. Copy numbers exactly as printed. Use 0 for a quantity or price the document doesn't have. Ignore handwriting and check marks. Do not guess a digit you cannot read: say what is unclear in "unclear".`;
// → the same shape as toInvoices, under the supplier's key
function toInvoicesAny(result, supplier) {
  const key = supplierKey(supplier), byOrder = new Map(), problems = [];
  const docs = (result && Array.isArray(result.documents)) ? result.documents : [];
  if (!docs.length) problems.push('No invoice or packing slip could be read from this file.');
  for (const d of docs) {
    const orderNumber = orderCode(key, d.document_number);
    if (!orderNumber || orderNumber.replace(/^[A-Z0-9]+-/, '').replace(/\D/g, '').length < 3) { problems.push(`A document's number couldn't be read ("${String(d.document_number || '').slice(0, 30)}").`); continue; }
    const shp = String(d.shipment_number || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
    const inv = byOrder.get(orderNumber) || { orderNumber, date: '', slips: [], items: [], bySlip: {}, warnings: [], supplier: String(supplier || '').trim().slice(0, 60), printedSupplier: String(d.supplier_name || '').trim().slice(0, 80), backordered: [] };
    byOrder.set(orderNumber, inv);
    if (!inv.date) inv.date = shortDate(d.date);
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const slipKey = shp || ('noshp:' + lines.map(l => itemCode(key, l.item_number) + 'x' + (l.qty_shipped | 0)).join(','));
    if (inv.slips.includes(slipKey)) continue;
    inv.slips.push(slipKey);
    const own = inv.bySlip[slipKey] = [];
    if (d.unclear && String(d.unclear).trim()) inv.warnings.push(String(d.unclear).trim().slice(0, 200));
    for (const l of lines) {
      const c = itemCode(key, l.item_number), q = parseInt(l.qty_shipped, 10), o = parseInt(l.qty_ordered, 10), bo = parseInt(l.qty_backordered, 10);
      const each = Number(l.each_price), ext = Number(l.extended_price), desc = String(l.description || '').trim().slice(0, 120);
      const upc = String(l.upc || '').replace(/\D/g, '');
      if (!c) { inv.warnings.push(`"${desc || 'a line'}": its item number couldn't be read — add that line by hand.`); continue; }
      if (!(q >= 0)) { inv.warnings.push(`${itemShown(c)} ${desc}: quantity shipped couldn't be read — add that line by hand.`); continue; }
      if (q > 0 && each > 0 && ext > 0 && Math.abs(q * each - ext) > 0.05) inv.warnings.push(`${itemShown(c)} ${desc}: ${q} shipped doesn't match the line's price total — check the quantity against the paper.`);
      if (bo > 0) inv.backordered.push({ item: itemShown(c), description: desc, qty: bo });
      if (q === 0) continue;   // backordered, nothing in this box
      const line = { cosmo_num: c, description: desc, qty_ordered: o >= q ? o : null, qty_shipped: q, unit_cost: each > 0 ? Math.round(each * 100) / 100 : null, upc: [12, 13, 14].includes(upc.length) ? upc : null };
      own.push(Object.assign({}, line));
      const prev = inv.items.find(i => i.cosmo_num === c);
      if (prev) { prev.qty_shipped += q; prev.qty_ordered = prev.qty_ordered != null && line.qty_ordered != null ? prev.qty_ordered + line.qty_ordered : null; }
      else inv.items.push(line);
    }
  }
  return { invoices: [...byOrder.values()], problems };
}

module.exports = { SCHEMA, PROMPT, toInvoices, shortDate, sku, SCHEMA_ANY, promptAny, toInvoicesAny, supplierKey, itemCode, orderCode, itemShown };

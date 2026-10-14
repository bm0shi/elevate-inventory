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
      const line = { cosmo_num: c, description: desc, qty_shipped: q, unit_cost: each > 0 ? Math.round(each * 100) / 100 : null };
      own.push(Object.assign({}, line));
      const prev = inv.items.find(i => i.cosmo_num === c);
      if (prev) prev.qty_shipped += q;
      else inv.items.push(line);
    }
  }
  return { invoices: [...byOrder.values()], problems };
}

module.exports = { SCHEMA, PROMPT, toInvoices, shortDate, sku };

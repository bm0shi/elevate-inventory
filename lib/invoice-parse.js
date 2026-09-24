// Cosmoprof invoice and Xstore receipt parsing: text in, orders out. No database access.
// Moved out of server.js unchanged so it can be tested on its own
// (test/invoice-parse.test.js).

// Invoice dates arrive in more than one shape. Screen captures of the order
// confirmation use words ("Sep 18, 2026") rather than 9/18/26, which is why
// those invoices were saved with no date. Always hand back M/D/YY.
function findInvoiceDate(text) {
  const t = String(text || '');
  const mdy = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (mdy) return `${+mdy[1]}/${+mdy[2]}/${mdy[3].slice(-2)}`;
  const MON = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
  const w = t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (w) return `${MON[w[1].toLowerCase()]}/${+w[2]}/${w[3].slice(-2)}`;
  const w2 = t.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})\b/i);
  if (w2) return `${MON[w2[2].toLowerCase()]}/${+w2[1]}/${w2[3].slice(-2)}`;
  const iso = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return `${+iso[2]}/${+iso[3]}/${iso[1].slice(-2)}`;
  const dash = t.match(/\b(\d{1,2})-(\d{1,2})-(20\d{2})\b/);
  if (dash) return `${+dash[1]}/${+dash[2]}/${dash[3].slice(-2)}`;
  return '';
}

// PURE parser — text in, orders map out. No database access, so it can be
// reused by the read-only audit endpoint.
// Shared: parse Cosmoprof invoice text (multi-order) into created invoices.
//
// IMPORTANT: Cosmoprof repeats "FOR ORDER NUMBER: xxx" on EVERY page of a
// multi-page invoice, so splitting on that header yields one segment PER PAGE,
// not per order. Each write begins with DELETE ... WHERE order_number, so
// writing per-segment used to wipe the earlier pages — a 2-page invoice kept
// only its last page, silently. We now merge every segment sharing an order
// number BEFORE touching the database.
function parseInvoiceText(text) {
  // Cosmoprof has sent at least three layouts. Accept every header style seen:
  //   "FOR ORDER NUMBER: 261642335"   (printed customer invoice)
  //   "Order Number: 261975620"       (order-confirmation screen capture)
  //   "Order #: 261964502"            (order-entry screen)
  const parts = text.split(/(?:FOR\s+)?ORDER\s*(?:NUMBER|NO\.?|#)\s*:?\s*(\d{6,})/i);
  const created = [], errors = [];

  const orders = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    const orderNumber = parts[i].trim();
    const body = parts[i + 1] || '';
    // The invoice date is printed in the page header immediately BEFORE this
    // order's "FOR ORDER NUMBER" line ("8/25/26  Beauty Systems Group ...").
    // Searching wider picked up neighbouring invoices' dates in multi-invoice PDFs.
    const hdr = [...String(parts[i - 1] || '').matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s+Beauty Systems/gi)];
    const dateM = (parts[i - 1] + body).match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g);
    const date = hdr.length ? hdr[hdr.length - 1][1]
               : (dateM ? dateM[dateM.length - 1] : findInvoiceDate(parts[i - 1] + body));

    if (!orders.has(orderNumber)) orders.set(orderNumber, { date, items: [], pages: 0, rejected: [] });
    const o = orders.get(orderNumber);
    o.pages++;
    if (!o.date && date) o.date = date;
    // "SHP# 139766144 FS D07163227" — FS is the store (OMS) order this invoice
    // bills. It links a store order receipt to its final invoice.
    // Only this order's own header block — the line right after the order
    // number. Looking back into the previous text borrowed the prior invoice's FS.
    const fs = body.slice(0, 300).match(/\bFS\s+(D\d{7,})\b/i);
    if (fs && !o.oms) o.oms = fs[1].toUpperCase();
    const due = body.match(/TOTAL AMOUNT DUE\.*\s*\$\s*([\d,]+\.\d{2})/i);
    if (due) o.totalDue = parseFloat(due[1].replace(/,/g, ''));
    // Printed invoices have ORDERED and SHIPPED columns. A line with only
    // ordered qty and price did not ship (backordered / cut).
    const printed = /EXTENDED/i.test(body);

    for (const line of body.split(/\r?\n/)) {
      let m = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+N\s*$/);
      if (m) { o.items.push({ cosmo_num: m[1], description: m[2].trim(), qty_shipped: parseInt(m[5]), unit_cost: parseFloat(m[4]) }); continue; }
      let m2 = line.match(/^\s*(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s*$/);
      if (m2) {
        o.items.push(printed
          ? { cosmo_num: m2[1], description: m2[2].trim(), qty_shipped: 0, qty_ordered: parseInt(m2[3]), unit_cost: parseFloat(m2[4]), not_shipped: true }
          : { cosmo_num: m2[1], description: m2[2].trim(), qty_shipped: parseInt(m2[3]), unit_cost: parseFloat(m2[4]), incomplete: true });
        continue;
      }
      // Looked like an item row but did not parse — surface it, never drop it.
      if (/^\s*\d{6}\s+\S/.test(line)) o.rejected.push(line.trim().slice(0, 90));
    }
  }

  return orders;
}

// Parse pasted Cosmoprof invoice text into {orderNumber, date, items[]}
function parseCosmoInvoice(text) {
  // Order number: try "ORDER NUMBER: X" (old) or "OMS Order ID: DXXXX" / "Xstore Order ID" (new)
  let orderNumber = null;
  let m1 = text.match(/ORDER NUMBER:\s*(\d+)/i);
  if (m1) orderNumber = m1[1];
  if (!orderNumber) {
    // new format: OMS Order ID: D 0 7 1 5 6 9 1 2  (spaces between digits)
    let m2 = text.match(/OMS\s*Order\s*ID:\s*([D0-9\s]+)/i);
    if (m2) orderNumber = m2[1].replace(/\s+/g,'').trim();
  }
  if (!orderNumber) {
    let m3 = text.match(/Transaction:\s*(\d+)/i);
    if (m3) orderNumber = 'T' + m3[1];
  }
  const dateMatch = text.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i) || text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  const date = dateMatch ? dateMatch[1] : '';

  const items = [];
  const lines = text.split(/\r?\n/);

  // FORMAT A (old): "ITEM# DESCRIPTION QTY PRICE QTY EXT N" all on one line
  const reA = /(\d{6})\s+(.+?)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+([\d,]+\.\d{2})\s+N/;
  // FORMAT B (new): a line "ITEM# QTY $price ..." with description on the previous non-empty line
  const reB = /^\s*(\d{6,7})\s+(\d+)\s+\$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const a = line.match(reA);
    if (a) {
      items.push({ cosmo_num: a[1], description: a[2].trim(), qty_ordered: parseInt(a[3]), qty_shipped: parseInt(a[5]) });
      continue;
    }
    const b = line.match(reB);
    if (b) {
      let cnum = b[1];
      // normalize 7-digit (leading 1) to 6-digit
      if (cnum.length === 7 && cnum[0] === '1') cnum = cnum.slice(1);
      const qty = parseInt(b[2]);
      // description = previous non-empty line that isn't a total/disc line
      let desc = '';
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!t) continue;
        if (/^(item ordered|disc|fp_|shipping|payment|subtotal|total|order deposit|tax|fee)/i.test(t)) continue;
        desc = t; break;
      }
      items.push({ cosmo_num: cnum, description: desc, qty_ordered: qty, qty_shipped: qty });
    }
  }
  // FORMAT C (fallback): copy-paste from PDF scrambles columns into separate
  // groups (all item#s together, all descriptions together, all quantities together).
  // If A and B found nothing, try zipping the groups back together.
  if (items.length === 0) {
    const itemNums = [];
    const descs = [];
    const qtys = [];
    for (const raw of lines) {
      const t = raw.trim();
      if (/^\d{6}$/.test(t)) itemNums.push(t);
      else if (/^\d{7}$/.test(t) && t[0]==='1') itemNums.push(t.slice(1));
      else if (/^[A-Z]/.test(t) && /(PM |PAUL|COLOR|TEA TREE|AWAPUHI|MITCH|LAVENDER)/i.test(t)
               && !/(TOTAL|MEMO|DISCOUNT|SHIPPED|ORDERED|CUSTOMER|BALANCE|PAYMENT|HANDLING)/i.test(t)) {
        descs.push(t);
      }
      else if (/^\d{1,4}$/.test(t)) qtys.push(parseInt(t));
    }
    if (itemNums.length > 0 && itemNums.length === descs.length) {
      // qtys usually contains ordered then shipped (duplicated). Use the first block.
      for (let i = 0; i < itemNums.length; i++) {
        const q = qtys[i] != null ? qtys[i] : 0;
        items.push({ cosmo_num: itemNums[i], description: descs[i], qty_ordered: q, qty_shipped: q });
      }
    }
  }

  return { orderNumber, date, items };
}

// Build cost history from invoice lines already in the database.
// Lots are only captured when a check-in COMPLETES, so every invoice received
// before that feature existed has its costs sitting unused in inv_invoice_items.
// This backfills them. It never touches stock.
// ============================================================
// COSTS-ONLY INVOICE IMPORT
// Reads prices out of invoice PDFs and writes NOTHING but cost history.
// It never touches inv_stock, inv_invoices, inv_invoice_items, pending_prep,
// shipments or locations — so old invoices can be mined for cost data without
// disturbing quantities that are already correct.
// The only tables it writes are inv_cost_history and (via recomputeCosts)
// the blended cost fields on inv_products.
// ============================================================
// ------------------------------------------------------------
// Cosmoprof Xstore ORDER receipts (store orders, "Customer Copy").
// Different from invoices in three ways that matter for cost:
//  - item numbers carry a leading 1 (1570941 = Cosmo# 570941)
//  - the Price column is LIST; the Amount column is already net of the
//    line discount, so true unit cost = Amount / Qty
//  - quantities are ordered, not shipped
// Returns the same Map shape as parseInvoiceText, plus a subtotal check.
// ------------------------------------------------------------
function parseXstoreOrder(text) {
  const orders = new Map();
  const raw = String(text || '');
  const flat = raw.replace(/[ \t]+/g, ' ');
  const squashed = raw.replace(/\s+/g, '');
  const oms = (squashed.match(/OMSOrderID:([A-Z]?\d{6,})/i) || [])[1];
  const xst = (squashed.match(/XstoreOrderID:(\d{8,})/i) || [])[1];
  if (!oms && !xst) return { orders, check: null };
  const orderNumber = oms || ('XS' + xst);
  const date = (flat.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/) || [])[1] || null;

  const lines = raw.split(/\r?\n/);
  const items = [];
  const re = /(?:^|\s)1(\d{6})\s+(\d+)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/;
  let prevText = '';
  for (const ln of lines) {
    const m = ln.match(re);
    if (m) {
      const before = ln.slice(0, m.index).trim();
      const qty = parseInt(m[2], 10);
      const amount = parseFloat(m[4].replace(/,/g, ''));
      items.push({
        cosmo_num: m[1],
        description: before || prevText,
        qty_shipped: qty,
        list_price: parseFloat(m[3].replace(/,/g, '')),
        amount,
        unit_cost: qty ? Math.round((amount / qty) * 10000) / 10000 : null
      });
      prevText = '';
      continue;
    }
    const t = ln.trim();
    if (!t) continue;
    if (/^(DISC_|FP_)/.test(t)) {
      // a page break can glue the next product's name onto a discount line
      const tail = t.replace(/^.*?\(\$[\d,]+\.\d{2}\)/, '').trim();
      if (tail) prevText = tail;
      continue;
    }
    if (!/^Item Ordered$|^\(\$/.test(t)) prevText = t;
  }
  if (!items.length) return { orders, check: null };
  orders.set(orderNumber, { date, items, source: 'xstore' });
  const subtotal = parseFloat(((flat.match(/Subtotal:\s*\$([\d,]+\.\d{2})/) || [])[1] || '').replace(/,/g, '')) || null;
  const tax = parseFloat(((flat.match(/Tax:\s*\$([\d,]+\.\d{2})/) || [])[1] || '').replace(/,/g, '')) || null;
  const sum = Math.round(items.reduce((n, x) => n + x.amount, 0) * 100) / 100;
  return { orders, check: { orderNumber, subtotal, sum, matches: subtotal != null && Math.abs(sum - subtotal) < 0.05, tax, lines: items.length } };
}

module.exports = { findInvoiceDate, parseInvoiceText, parseCosmoInvoice, parseXstoreOrder };

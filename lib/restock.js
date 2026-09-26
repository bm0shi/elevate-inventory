// ============================================================
// AMAZON'S RESTOCK RECOMMENDATION (GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT)
// Shown next to our own Send on Admin → Send Next, so the owner can see
// where the two disagree. Not used to plan: Amazon's number has proven
// unreliable for us (it doesn't know what's in the warehouse or in prep).
// The report is tab-separated. Columns are found by header name, since
// Amazon has renamed and reordered them before. Pure: no database access.
// ============================================================

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// First header that matches any of the names (exact after normalising,
// then "starts with" for the long ones like "Total Days of Supply (…)").
function col(headers, names) {
  const h = headers.map(norm);
  for (const n of names) { const i = h.indexOf(norm(n)); if (i >= 0) return i; }
  for (const n of names) { const i = h.findIndex(x => x.startsWith(norm(n))); if (i >= 0) return i; }
  return -1;
}

const num = (v) => {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
};

// text → { bySku: { sku: row }, byAsin: { asin: row } }
// row: { sku, asin, fnsku, qty, shipDate, alert, action, daysSupply, sold30 }
// byAsin sums qty across the ASIN's SKUs (and keeps the earliest ship date).
function parseRestockReport(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const bySku = {}, byAsin = {};
  if (!lines.length) return { bySku, byAsin };
  const headers = lines[0].split('\t');
  const ix = {
    sku: col(headers, ['Merchant SKU', 'SKU', 'seller-sku']),
    asin: col(headers, ['ASIN']),
    fnsku: col(headers, ['FNSKU']),
    qty: col(headers, ['Recommended replenishment qty', 'Recommended replenishment quantity', 'Recommended ship-in quantity']),
    shipDate: col(headers, ['Recommended ship date', 'Recommended ship-in date']),
    alert: col(headers, ['Alert']),
    action: col(headers, ['Recommended action']),
    daysSupply: col(headers, ['Total Days of Supply', 'Days of Supply at Amazon Fulfillment Network']),
    sold30: col(headers, ['Units Sold Last 30 Days']),
  };
  if (ix.qty < 0 || (ix.sku < 0 && ix.asin < 0)) throw new Error('Restock report: expected columns not found (' + headers.slice(0, 8).join(', ') + '…)');
  const get = (c, k) => (ix[k] >= 0 ? (c[ix[k]] || '').trim() : '');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const row = {
      sku: get(c, 'sku') || null, asin: get(c, 'asin') || null, fnsku: get(c, 'fnsku') || null,
      qty: num(get(c, 'qty')) ?? 0,
      shipDate: get(c, 'shipDate') || null, alert: get(c, 'alert') || null, action: get(c, 'action') || null,
      daysSupply: num(get(c, 'daysSupply')), sold30: num(get(c, 'sold30')),
    };
    if (!row.sku && !row.asin) continue;
    if (row.sku) bySku[row.sku] = row;
    if (row.asin) {
      const a = byAsin[row.asin];
      if (!a) byAsin[row.asin] = { ...row };
      else {
        a.qty += row.qty;
        if (row.shipDate && (!a.shipDate || Date.parse(row.shipDate) < Date.parse(a.shipDate))) a.shipDate = row.shipDate;
        if (!a.alert && row.alert) a.alert = row.alert;
      }
    }
  }
  return { bySku, byAsin };
}

module.exports = { parseRestockReport };

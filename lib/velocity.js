// Units sold from Amazon's all-orders flat file (GET_FLAT_FILE_ALL_ORDERS_
// DATA_BY_LAST_UPDATE_GENERAL), per seller SKU and per ASIN.
//
// Per ASIN matters: the catalog keeps one SKU per product, but an ASIN can
// sell under several of our SKUs (a relisted SKU, an Amazon-made one). Our
// units used to be looked up by the catalog SKU only, so a listing selling
// under another SKU read 0 on the Smart Scout attack list (a 45% Buy Box
// with 0 units a month).
//
// Takes one report body or several (a long window is pulled in pieces: Amazon
// allows at most 30 days per order report). A line seen in two pieces is
// counted once (order id + SKU + ASIN). `lines`/`units` say what the report
// held, so an empty pull is visible instead of reading as zero sales.
function parseOrdersReport(bodies, afterMs) {
  const bySku = {}, byAsin = {};
  const seen = new Set();
  let lines = 0, units = 0;
  for (const body of [].concat(bodies)) {
    const rows = String(body || '').split(/\r?\n/).filter(l => l);
    if (!rows.length) continue;
    const headers = rows[0].split('\t');
    const idIdx = headers.indexOf('amazon-order-id');
    const skuIdx = headers.indexOf('sku');
    const asinIdx = headers.indexOf('asin');
    const qtyIdx = headers.indexOf('quantity');
    const statusIdx = headers.indexOf('item-status');
    // The report selects orders by LAST UPDATE. An order placed before the
    // window but shipped/refunded inside it was counted, inflating velocity.
    const dateIdx = headers.indexOf('purchase-date');
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].split('\t');
      const sku = skuIdx >= 0 ? (c[skuIdx] || '').trim() : '';
      const asin = asinIdx >= 0 ? (c[asinIdx] || '').trim() : '';
      const qty = parseInt(c[qtyIdx]) || 0;
      const st = (c[statusIdx] || '').toLowerCase();
      if ((!sku && !asin) || qty <= 0 || st === 'cancelled') continue;
      if (dateIdx >= 0 && afterMs != null) { const pd = Date.parse(c[dateIdx]); if (!isNaN(pd) && pd < afterMs) continue; }
      if (idIdx >= 0 && c[idIdx]) {
        const key = c[idIdx] + '|' + sku + '|' + asin;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      lines++; units += qty;
      if (sku) bySku[sku] = (bySku[sku] || 0) + qty;
      if (asin) byAsin[asin] = (byAsin[asin] || 0) + qty;
    }
  }
  return { bySku, byAsin, lines, units };
}

// [start, end] pieces of at most `maxDays`, oldest first, covering the last
// `days` days up to `nowMs`.
function reportWindows(days, nowMs, maxDays = 30) {
  const DAY = 86400000, out = [];
  let end = nowMs;
  const start = nowMs - days * DAY;
  while (end > start) {
    const s = Math.max(start, end - maxDays * DAY);
    out.unshift([new Date(s).toISOString(), new Date(end).toISOString()]);
    end = s;
  }
  return out;
}

// Units for one catalog product: everything sold on its ASIN (all our SKUs),
// else what its catalog SKU sold (reports without an asin column).
function unitsFor(sales, asin, sku) {
  if (sales.byAsin && asin && sales.byAsin[asin] != null) return sales.byAsin[asin];
  return (sales.bySku && sku && sales.bySku[sku]) || 0;
}

module.exports = { parseOrdersReport, reportWindows, unitsFor };

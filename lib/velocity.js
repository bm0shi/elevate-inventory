// Units sold from Amazon's all-orders flat file (GET_FLAT_FILE_ALL_ORDERS_
// DATA_BY_LAST_UPDATE_GENERAL), per seller SKU and per ASIN.
//
// Per ASIN matters: the catalog keeps one SKU per product, but an ASIN can
// sell under several of our SKUs (a relisted SKU, an Amazon-made one). Our
// units used to be looked up by the catalog SKU only, so a listing selling
// under another SKU read 0 on the Smart Scout attack list (a 45% Buy Box
// with 0 units a month).
function parseOrdersReport(body, afterMs) {
  const bySku = {}, byAsin = {};
  const lines = String(body || '').split(/\r?\n/).filter(l => l);
  if (!lines.length) return { bySku, byAsin };
  const headers = lines[0].split('\t');
  const skuIdx = headers.indexOf('sku');
  const asinIdx = headers.indexOf('asin');
  const qtyIdx = headers.indexOf('quantity');
  const statusIdx = headers.indexOf('item-status');
  // The report selects orders by LAST UPDATE. An order placed before the
  // window but shipped/refunded inside it was counted, inflating velocity.
  const dateIdx = headers.indexOf('purchase-date');
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split('\t');
    const sku = c[skuIdx];
    const asin = asinIdx >= 0 ? (c[asinIdx] || '').trim() : '';
    const qty = parseInt(c[qtyIdx]) || 0;
    const st = (c[statusIdx] || '').toLowerCase();
    if ((!sku && !asin) || qty <= 0 || st === 'cancelled') continue;
    if (dateIdx >= 0 && afterMs != null) { const pd = Date.parse(c[dateIdx]); if (!isNaN(pd) && pd < afterMs) continue; }
    if (sku) bySku[sku] = (bySku[sku] || 0) + qty;
    if (asin) byAsin[asin] = (byAsin[asin] || 0) + qty;
  }
  return { bySku, byAsin };
}

// Units for one catalog product: everything sold on its ASIN (all our SKUs),
// else what its catalog SKU sold (reports without an asin column).
function unitsFor(sales, asin, sku) {
  if (sales.byAsin && asin && sales.byAsin[asin] != null) return sales.byAsin[asin];
  return (sales.bySku && sku && sales.bySku[sku]) || 0;
}

module.exports = { parseOrdersReport, unitsFor };

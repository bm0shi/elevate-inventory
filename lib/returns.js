// Customer returns from Amazon's FBA returns report
// (GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA), for the dashboard's Returns
// metric. One record per returned line: when, which listing, how many, why,
// and what Amazon did with it. Pure (no database).
//
// Columns: return-date, order-id, sku, asin, fnsku, product-name, quantity,
// fulfillment-center-id, detailed-disposition, reason, status,
// license-plate-number, customer-comments. A return can appear in two
// overlapping report windows; the key (order + sku + license plate + date)
// counts it once.
function parseReturns(bodies) {
  const out = [], seen = new Set();
  for (const body of [].concat(bodies)) {
    const rows = String(body || '').split(/\r?\n/).filter(l => l);
    if (!rows.length) continue;
    const h = rows[0].split('\t').map(x => x.trim().toLowerCase()), at = n => h.indexOf(n);
    const iDate = at('return-date'), iOrder = at('order-id'), iSku = at('sku'), iAsin = at('asin'), iQty = at('quantity'),
          iDisp = at('detailed-disposition'), iReason = at('reason'), iStatus = at('status'), iLpn = at('license-plate-number');
    if (iDate < 0 || iQty < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].split('\t');
      const ts = Date.parse(c[iDate]); const qty = parseInt(c[iQty]) || 0;
      if (isNaN(ts) || qty <= 0) continue;
      const rec = { ts, order: iOrder >= 0 ? (c[iOrder] || '').trim() : '', sku: iSku >= 0 ? (c[iSku] || '').trim() : '',
                    asin: iAsin >= 0 ? (c[iAsin] || '').trim() : '', qty,
                    disposition: iDisp >= 0 ? (c[iDisp] || '').trim() : '', reason: iReason >= 0 ? (c[iReason] || '').trim() : '',
                    status: iStatus >= 0 ? (c[iStatus] || '').trim() : '', lpn: iLpn >= 0 ? (c[iLpn] || '').trim() : '' };
      const key = [rec.order, rec.sku, rec.lpn, c[iDate]].join('|');
      if (seen.has(key)) continue; seen.add(key);
      out.push(rec);
    }
  }
  return out;
}

module.exports = { parseReturns };

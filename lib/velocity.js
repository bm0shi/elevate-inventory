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

// ---------- gross sales, like Amazon's app ("ordered product sales") ----------
// One record per order line from the same all-orders report: when it was
// ordered, units and item-price (the line total, before tax). Cancelled
// lines are left out; pending ones are kept, as Amazon's app counts them.
// A pending line often has no price yet: it's priced at that ASIN's average
// unit price in the same pull (else the overall average) and flagged `est`.
function orderRecords(bodies, afterMs) {
  const recs = [], seen = new Set();
  for (const body of [].concat(bodies)) {
    const rows = String(body || '').split(/\r?\n/).filter(l => l);
    if (!rows.length) continue;
    const h = rows[0].split('\t'), at = n => h.indexOf(n);
    const iId = at('amazon-order-id'), iSku = at('sku'), iAsin = at('asin'), iQty = at('quantity'),
          iItem = at('item-status'), iOrder = at('order-status'), iDate = at('purchase-date'), iPrice = at('item-price');
    if (iDate < 0) continue;
    for (let i = 1; i < rows.length; i++) {
      const c = rows[i].split('\t');
      const qty = parseInt(c[iQty]) || 0;
      if (qty <= 0) continue;
      if (/cancel/i.test(c[iItem] || '') || /cancel/i.test(c[iOrder] || '')) continue;
      const ts = Date.parse(c[iDate]);
      if (isNaN(ts) || (afterMs != null && ts < afterMs)) continue;
      const sku = iSku >= 0 ? (c[iSku] || '').trim() : '', asin = iAsin >= 0 ? (c[iAsin] || '').trim() : '';
      const key = (iId >= 0 ? c[iId] : '') + '|' + sku + '|' + asin;
      if (iId >= 0 && c[iId]) { if (seen.has(key)) continue; seen.add(key); }
      const raw = iPrice >= 0 ? String(c[iPrice] || '').replace(/[^0-9.\-]/g, '') : '';
      const price = raw === '' ? null : parseFloat(raw);
      recs.push({ ts, asin, sku, qty, price: price != null && isFinite(price) && price > 0 ? price : null });
    }
  }
  // price the unpriced (pending) lines
  const per = {}; let gq = 0, gp = 0;
  for (const r of recs) if (r.price != null) { const k = r.asin || r.sku; const x = per[k] = per[k] || { q: 0, p: 0 }; x.q += r.qty; x.p += r.price; gq += r.qty; gp += r.price; }
  const gAvg = gq ? gp / gq : 0;
  for (const r of recs) if (r.price == null) { const x = per[r.asin || r.sku]; r.price = r.qty * (x && x.q ? x.p / x.q : gAvg); r.est = true; }
  return recs;
}

// Calendar day / hour in Amazon's time zone (Pacific, like Seller Central).
const _fmt = {};
function zoneParts(ms, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }));
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: p.year + '-' + p.month + '-' + p.day, hour: parseInt(p.hour) % 24 };
}
// { 'YYYY-MM-DD': { units, sales, est } } for every day from `fromDay` to
// `toDay` (zeros included, so a quiet day reads as 0, not "no data").
function salesByDay(recs, fromDay, toDay, tz = 'America/Los_Angeles') {
  const out = {};
  for (let d = new Date(fromDay + 'T12:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10); if (k > toDay) break; out[k] = { units: 0, sales: 0, est: 0 };
  }
  for (const r of recs) {
    const k = zoneParts(r.ts, tz).day; const x = out[k]; if (!x) continue;
    x.units += r.qty; x.sales += r.price; if (r.est) x.est += r.price;
  }
  for (const k in out) { out[k].sales = Math.round(out[k].sales * 100) / 100; out[k].est = Math.round(out[k].est * 100) / 100; }
  return out;
}
// Sales per hour for one day (24 slots), for "today vs yesterday by now".
function salesByHour(recs, day, tz = 'America/Los_Angeles') {
  const h = Array(24).fill(0);
  for (const r of recs) { const z = zoneParts(r.ts, tz); if (z.day === day) h[z.hour] += r.price; }
  return h.map(v => Math.round(v * 100) / 100);
}

module.exports = { parseOrdersReport, reportWindows, unitsFor, orderRecords, salesByDay, salesByHour, zoneParts };

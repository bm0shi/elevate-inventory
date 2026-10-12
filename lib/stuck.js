// Money stuck at Amazon (owner's "think big" #3): stock Amazon holds that
// can't sell, and fees coming for stock that sits. Pure: parses Amazon's
// tab-separated reports by column name (a missing column reads as empty, so
// a renamed column hides a number rather than breaking the screen).
//   stranded   GET_STRANDED_INVENTORY_UI_DATA     at Amazon, no active listing
//   unsellable GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA  afn-unsellable / researching
//   aged       GET_FBA_INVENTORY_PLANNING_DATA    age buckets, aged-inventory surcharge

const int = v => { const n = parseInt(String(v == null ? '' : v).replace(/,/g, ''), 10); return isNaN(n) ? 0 : n; };
const money = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')); return isNaN(n) ? 0 : n; };

function table(body) {
  const rows = String(body || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!rows.length) return [];
  const h = rows[0].split('\t').map(x => x.trim().toLowerCase());
  return rows.slice(1).map(l => { const c = l.split('\t'), o = {}; h.forEach((k, i) => { o[k] = (c[i] || '').trim(); }); return o; });
}
const pick = (o, ...names) => { for (const n of names) if (o[n] != null && o[n] !== '') return o[n]; return ''; };

function parseStranded(body) {
  return table(body).map(r => ({
    sku: pick(r, 'sku'), fnsku: pick(r, 'fnsku'), asin: pick(r, 'asin'), name: pick(r, 'product-name'),
    units: int(pick(r, 'fulfillable-qty', 'fulfillable-quantity')) + int(pick(r, 'unfulfillable-qty', 'unfulfillable-quantity')),
    reason: pick(r, 'stranded-reason', 'status-primary', 'error-message'), action: pick(r, 'primary-action'),
    since: pick(r, 'date-stranded'), autoRemoval: pick(r, 'date-to-take-auto-removal'),
  })).filter(x => x.sku && x.units > 0);
}

function parseUnsellable(body) {
  return table(body).map(r => ({
    sku: pick(r, 'sku'), fnsku: pick(r, 'fnsku'), asin: pick(r, 'asin'), name: pick(r, 'product-name'),
    unsellable: int(pick(r, 'afn-unsellable-quantity')), researching: int(pick(r, 'afn-researching-quantity')),
  })).filter(x => x.sku && (x.unsellable > 0 || x.researching > 0));
}

// Aged inventory: units 181+ days old, and what Amazon expects to charge
// next month (every estimated-ais-* column is a bucket of the surcharge).
function parseAged(body) {
  return table(body).map(r => {
    let ais = 0;
    for (const k of Object.keys(r)) if (/^estimated-ais-/.test(k)) ais += money(r[k]);
    const old = ['inv-age-181-to-270-days', 'inv-age-271-to-365-days', 'inv-age-365-plus-days', 'inv-age-181-to-330-days', 'inv-age-331-to-365-days']
      .reduce((n, k) => n + int(r[k]), 0);
    return { sku: pick(r, 'sku'), fnsku: pick(r, 'fnsku'), asin: pick(r, 'asin'), name: pick(r, 'product-name'),
      available: int(pick(r, 'available')), aged181: old, surcharge: Math.round(ais * 100) / 100,
      storageNext: money(pick(r, 'estimated-storage-cost-next-month')), action: pick(r, 'recommended-action'),
      daysOfSupply: int(pick(r, 'days-of-supply')) || null };
  }).filter(x => x.sku && (x.aged181 > 0 || x.surcharge > 0));
}

// Money tied up: units × what they cost us (null when we don't know the cost).
function tiedUp(rows, unitsKey, costBySku) {
  let total = 0, unknown = 0;
  for (const r of rows) {
    const c = costBySku[r.sku];
    if (c != null) total += c * (r[unitsKey] || 0); else unknown += r[unitsKey] || 0;
  }
  return { total: Math.round(total * 100) / 100, unknownUnits: unknown };
}

module.exports = { parseStranded, parseUnsellable, parseAged, tiedUp, table };

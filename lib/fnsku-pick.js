// ============================================================
// ONE ASIN, SEVERAL AMAZON LISTINGS (owner 10/19: "found two issues where we
// have the wrong FNSKU on the elevate app … see why this happened").
//
// The app keeps one seller SKU and one FNSKU per product, and the FBA sync
// updates the FNSKU only for that SKU (an ASIN's other SKUs may only fill a
// blank: overwriting made the FNSKU flip on every sync). So when a new listing
// was made for the same ASIN (Extra-Body Sculpting Gel and MITCH Original
// Pomade, Oct 16), the app kept the old listing's FNSKU and the floor labelled
// for a listing that wasn't the one being shipped.
//
// findConflicts lists every catalog ASIN that Amazon now shows under more than
// one FNSKU, unless the owner already picked among exactly those SKUs. A
// product whose saved SKU is gone from Amazon, with only one other listing
// left, is safe to switch without asking (autoSwitch). Pure: no database.
// ============================================================

// products: [{ asin, sku, fnsku }] (the catalog); fba: { sellerSku: { sku, asin,
// fnSku, total, fulfillable, inbound, lastUpdated } } (getFbaInventory);
// acked: { asin: [skus the owner has already chosen among] }.
// → { conflicts: [{ asin, current: { sku, fnsku }, options: [...] }], autoSwitch: [{ asin, sku, fnsku, from }] }
function findConflicts(products, fba, acked) {
  const byAsin = {};
  for (const f of Object.values(fba || {})) {
    if (!f || !f.asin || !f.fnSku) continue;
    (byAsin[f.asin] = byAsin[f.asin] || []).push(f);
  }
  // a SKU that belongs to another catalog product isn't this product's option
  const skuOwner = {};
  for (const p of products || []) if (p.sku) skuOwner[p.sku] = p.asin;
  const conflicts = [], autoSwitch = [];
  for (const p of products || []) {
    const opts = (byAsin[p.asin] || []).filter(f => !skuOwner[f.sku] || skuOwner[f.sku] === p.asin);
    const fnskus = new Set(opts.map(o => String(o.fnSku).toUpperCase()));
    const mine = opts.find(o => o.sku === p.sku);
    if (!mine && p.sku && opts.length === 1) {
      // the saved listing is gone from Amazon; the only one left is the one to label with
      if (String(opts[0].fnSku).toUpperCase() !== String(p.fnsku || '').toUpperCase() || opts[0].sku !== p.sku)
        autoSwitch.push({ asin: p.asin, sku: opts[0].sku, fnsku: opts[0].fnSku, from: { sku: p.sku, fnsku: p.fnsku || null } });
      continue;
    }
    if (fnskus.size < 2) continue;
    const seen = new Set((acked && acked[p.asin]) || []);
    if (opts.every(o => seen.has(o.sku))) continue;   // already picked among exactly these
    conflicts.push({
      asin: p.asin,
      current: { sku: p.sku || null, fnsku: p.fnsku || null },
      options: opts.map(o => ({ sku: o.sku, fnsku: o.fnSku, total: o.total || 0, fulfillable: o.fulfillable || 0,
        inbound: o.inbound || 0, lastUpdated: o.lastUpdated || null, current: o.sku === p.sku }))
        .sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || ''))),
    });
  }
  return { conflicts, autoSwitch };
}

// A FNSKU set by hand (🔧 Fix a wrong FNSKU mapping) used to last only until
// the next sync, which puts back the saved SKU's FNSKU. So a hand fix is
// pinned: kept over the sync until Amazon shows that FNSKU under a listing of
// the same ASIN, and then the product moves to that listing (SKU and FNSKU)
// and the pin is released.
// pins: { asin: fnsku } → [{ asin, fnsku, sku (when found), release, skus (the ASIN's listings) }]
function resolvePins(pins, fba) {
  const byAsin = {};
  for (const f of Object.values(fba || {})) if (f && f.asin && f.fnSku) (byAsin[f.asin] = byAsin[f.asin] || []).push(f);
  return Object.entries(pins || {}).map(([asin, fnsku]) => {
    const list = byAsin[asin] || [];
    const hit = list.find(f => String(f.fnSku).toUpperCase() === String(fnsku).toUpperCase());
    return hit ? { asin, fnsku: hit.fnSku, sku: hit.sku, release: true, skus: list.map(f => f.sku) }
               : { asin, fnsku, sku: null, release: false, skus: list.map(f => f.sku) };
  });
}

module.exports = { findConflicts, resolvePins };

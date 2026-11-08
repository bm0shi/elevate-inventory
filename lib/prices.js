// Our own listing price per ASIN from Amazon's getPricing answer (Product
// Pricing v0, ItemType=Asin, up to 20 ASINs a call), for Inventory Value.
// Owner 11/8: the pull asked for each product's offers one at a time with a
// 2 s pause (that endpoint's limit), 5+ minutes for the catalog; this one
// prices 20 at a time, our own price (what the stock sells for), the Buy Box
// lookup only for listings it can't price. Pure: payload in, { asin: price }
// out; an entry with no offer of ours, or a failed status, is left out.
function myPricesFromPayload(payload) {
  const out = {};
  for (const e of Array.isArray(payload) ? payload : []) {
    if (!e || String(e.status || '').toLowerCase() !== 'success') continue;
    const asin = e.ASIN || (e.Product && e.Product.Identifiers && e.Product.Identifiers.MarketplaceASIN && e.Product.Identifiers.MarketplaceASIN.ASIN);
    const offers = (e.Product && e.Product.Offers) || [];
    let amt = null;
    for (const o of offers) {
      const bp = o && o.BuyingPrice;
      const v = bp && ((bp.ListingPrice && Number(bp.ListingPrice.Amount)) || (bp.LandedPrice && Number(bp.LandedPrice.Amount)));
      if (v > 0) { amt = v; break; }
    }
    if (asin && amt) out[asin] = amt;
  }
  return out;
}
// ASINs in groups of n (Amazon takes up to 20).
function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
module.exports = { myPricesFromPayload, chunk };

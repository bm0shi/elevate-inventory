// ============================================================
// keepa.js — Keepa API integration (corrected per official docs)
// https://keepa.com/api-docs/product-object.html
// ============================================================
const axios = require('axios');

const KEEPA_BASE = 'https://api.keepa.com';
const DOMAIN = 1; // amazon.com
const AMAZON_SELLER_ID = 'ATVPDKIKX0DER';

function keyOk() { return !!process.env.KEEPA_API_KEY; }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// csv/stats index constants
const IDX = { AMAZON:0, NEW:1, SALES:3, COUNT_NEW:11, BUY_BOX:18 };

// Fetch product data for ASINs (up to 100 per request). stats=90 for 90-day stats.
async function getProducts(asins) {
  if (!keyOk()) throw new Error('KEEPA_API_KEY not set');
  const key = process.env.KEEPA_API_KEY;
  const out = [];
  let tokensLeft = null;
  for (let i = 0; i < asins.length; i += 100) {
    const batch = asins.slice(i, i + 100);
    const url = `${KEEPA_BASE}/product?key=${key}&domain=${DOMAIN}&asin=${batch.join(',')}&stats=90&buybox=1`;

    let done = false, attempts = 0;
    while (!done && attempts < 6) {
      attempts++;
      let resp;
      try {
        resp = await axios.get(url, { timeout: 60000, decompress: true });
      } catch (err) {
        if (err.response?.status === 429) {
          // out of tokens — wait for refill then retry
          const refillIn = err.response.data?.refillIn || 20000;
          await sleep(Math.min(refillIn + 1000, 65000));
          continue;
        }
        const body = err.response?.data ? JSON.stringify(err.response.data).slice(0,300) : err.message;
        throw new Error(`Keepa ${err.response?.status || ''}: ${body}`);
      }
      if (resp.data.error && resp.data.error.type === 'NOT_ENOUGH_TOKEN') {
        const refillIn = resp.data.refillIn || 20000;
        await sleep(Math.min(refillIn + 1000, 65000));
        continue;
      }
      tokensLeft = resp.data.tokensLeft;
      const products = resp.data.products || [];
      for (const p of products) out.push(simplify(p));
      done = true;

      // if tokens are running low, wait for the bucket to refill before next batch
      if (tokensLeft != null && tokensLeft < 50 && i + 100 < asins.length) {
        const refillIn = resp.data.refillIn || 15000;
        await sleep(Math.min(refillIn + 1000, 65000));
      } else {
        await sleep(1200);
      }
    }
    if (!done) throw new Error('Keepa: exhausted retries waiting for tokens');
  }
  return { products: out, tokensLeft };
}

function cents(v){ return (v == null || v < 0) ? null : v / 100; }

function simplify(p) {
  const stats = p.stats || {};
  const cur = stats.current || [];      // current value per csv index
  const avg30 = stats.avg30 || [];

  // Sales rank (index 3). Lower = better.
  const salesRank = (cur[IDX.SALES] != null && cur[IDX.SALES] >= 0) ? cur[IDX.SALES] : null;
  const salesRankAvg30 = (avg30[IDX.SALES] != null && avg30[IDX.SALES] >= 0) ? avg30[IDX.SALES] : null;

  // Buy box price (index 18). -1 = none.
  const buyBoxPrice = cents(cur[IDX.BUY_BOX]);
  // Amazon price (index 0)
  const amazonPrice = cents(cur[IDX.AMAZON]);

  // Offer count: COUNT_NEW (index 11) = number of new marketplace sellers
  const offerCount = (cur[IDX.COUNT_NEW] != null && cur[IDX.COUNT_NEW] >= 0) ? cur[IDX.COUNT_NEW] : null;

  // Who holds the buy box currently (last entry of buyBoxSellerIdHistory)
  let amazonHasBuyBox = false;
  if (Array.isArray(p.buyBoxSellerIdHistory) && p.buyBoxSellerIdHistory.length) {
    const lastSeller = p.buyBoxSellerIdHistory[p.buyBoxSellerIdHistory.length - 1];
    amazonHasBuyBox = (lastSeller === AMAZON_SELLER_ID);
  }

  // Amazon out-of-stock %: stats.outOfStockPercentage is [amazon%, new%] over the interval
  let amazonOOS = null;
  if (Array.isArray(stats.outOfStockPercentage) && stats.outOfStockPercentage[IDX.AMAZON] != null && stats.outOfStockPercentage[IDX.AMAZON] >= 0) {
    amazonOOS = stats.outOfStockPercentage[IDX.AMAZON];
  }

  // monthlySold: real "bought past month" figure (bracketed by Amazon). Most ASINs lack it.
  const monthlySold = (p.monthlySold != null) ? p.monthlySold : null;

  // image: Keepa gives imagesCSV (comma-sep filenames). First one = main image.
  let image = null;
  if (p.imagesCSV) {
    const first = p.imagesCSV.split(',')[0];
    if (first) image = 'https://m.media-amazon.com/images/I/' + first;
  }
  return {
    asin: p.asin,
    title: p.title || '',
    brand: p.brand || '',
    image,
    productType: p.productType,
    salesRank, salesRankAvg30,
    buyBoxPrice, amazonPrice,
    amazonHasBuyBox, amazonOOS,
    offerCount, monthlySold,
  };
}

module.exports = { getProducts, keyOk };

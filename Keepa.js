// ============================================================
// keepa.js — Keepa API integration for market data
// Docs: https://keepa.com/#!discuss/t/product-object/116
// ============================================================
const axios = require('axios');

const KEEPA_BASE = 'https://api.keepa.com';
const DOMAIN = 1; // 1 = amazon.com (US)

function keyOk() { return !!process.env.KEEPA_API_KEY; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Fetch product data for a batch of ASINs (Keepa accepts up to 100 per request).
// Returns array of simplified product objects.
async function getProducts(asins) {
  if (!keyOk()) throw new Error('KEEPA_API_KEY not set');
  const key = process.env.KEEPA_API_KEY;
  const out = [];
  // Keepa allows up to 100 ASINs per call. stats=90 gives 90-day stats.
  for (let i = 0; i < asins.length; i += 100) {
    const batch = asins.slice(i, i + 100);
    const url = `${KEEPA_BASE}/product?key=${key}&domain=${DOMAIN}&asin=${batch.join(',')}&stats=90&offers=20&buybox=1`;
    let resp;
    try {
      resp = await axios.get(url, { timeout: 60000 });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data).slice(0,200) : err.message;
      throw new Error(`Keepa ${err.response?.status || ''}: ${body}`);
    }
    const products = resp.data.products || [];
    for (const p of products) {
      out.push(simplify(p));
    }
    // token-friendly pause between batches
    await sleep(1500);
  }
  return out;
}

// Turn a raw Keepa product into the fields we care about
function simplify(p) {
  const stats = p.stats || {};
  // Keepa prices are in cents; -1 means no data
  const cents = v => (v == null || v < 0) ? null : v / 100;
  // current values array indices: 0=AMAZON,1=NEW,2=USED,3=SALES(rank),...,18=BUY_BOX
  const cur = stats.current || [];
  const avg30 = stats.avg30 || [];
  const salesRank = cur[3] != null && cur[3] >= 0 ? cur[3] : null;
  const salesRankAvg30 = avg30[3] != null && avg30[3] >= 0 ? avg30[3] : null;

  // buy box: is Amazon the seller? Keepa buyBoxSellerId 'ATVPDKIKX0DER' = Amazon
  const buyBoxSeller = p.buyBoxSellerIdHistory ? p.buyBoxSellerIdHistory[p.buyBoxSellerIdHistory.length-1] : null;
  const amazonHasBuyBox = buyBoxSeller === 'ATVPDKIKX0DER';

  // Amazon in-stock rate over 90 days (outOfStockPercentage for Amazon offer)
  const amazonOOS = stats.outOfStockPercentageInInterval ? stats.outOfStockPercentageInInterval[0] : null;

  // offer count (number of new offers)
  const offerCount = cur[11] != null && cur[11] >= 0 ? cur[11] : (p.offers ? p.offers.length : null);

  // estimated monthly sales (Keepa provides monthlySold on some products)
  const monthlySold = p.monthlySold != null ? p.monthlySold : null;

  return {
    asin: p.asin,
    title: p.title || '',
    brand: p.brand || '',
    salesRank,
    salesRankAvg30,
    buyBoxPrice: cents(cur[18]),
    amazonPrice: cents(cur[0]),
    newPrice: cents(cur[1]),
    amazonHasBuyBox,
    amazonOOS,          // % of time Amazon was out of stock (higher = Amazon weak = opportunity)
    offerCount,          // fewer offers = less competition
    monthlySold,         // Keepa's "bought in past month" if available
  };
}

module.exports = { getProducts, keyOk };

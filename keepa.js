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
// onBatch(products, info) is called after EVERY successful batch so the caller
// can persist progress. A batch that fails after its retries is recorded and
// skipped rather than throwing away the whole run — previously one bad batch
// discarded all the tokens already spent.
async function getProducts(asins, onProgress, onBatch) {
  if (!keyOk()) throw new Error('KEEPA_API_KEY not set');
  const key = process.env.KEEPA_API_KEY;
  const out = [];
  const failed = [];
  let tokensLeft = null;
  for (let i = 0; i < asins.length; i += 100) {
    const batch = asins.slice(i, i + 100);
    if (onProgress) onProgress(`batch ${Math.floor(i/100)+1} of ${Math.ceil(asins.length/100)} — ${out.length} products so far`);
    const url = `${KEEPA_BASE}/product?key=${key}&domain=${DOMAIN}&asin=${batch.join(',')}&stats=90&buybox=1`;

    let done = false, attempts = 0;
    while (!done && attempts < 6) {
      attempts++;
      let resp;
      try {
        resp = await axios.get(url, { timeout: 60000, decompress: true });
      } catch (err) {
        if (err.response?.status === 429) {
          const refillIn = err.response.data?.refillIn || 20000;
          await sleep(Math.min(refillIn + 1000, 65000));
          continue;
        }
        // "upstream error" or other non-JSON = Keepa server issue or overload
        const status = err.response?.status;
        let body = err.response?.data;
        if (typeof body === 'string') body = body.slice(0,150);
        else if (body) body = JSON.stringify(body).slice(0,150);
        else body = err.message;
        // retry upstream/5xx errors a couple times before giving up
        if (status >= 500 || String(body).includes('upstream')) {
          if (attempts < 4) { await sleep(5000); continue; }
        }
        console.error(`[Keepa] ${status || ''}: ${String(body).slice(0,120)}`);
        break; // abandon this batch, keep everything already fetched
      }
      // response might not be JSON (Keepa returned an error page)
      if (typeof resp.data === 'string') {
        if (attempts < 4) { await sleep(5000); continue; }
        console.error('[Keepa] non-JSON response (overloaded or out of tokens) — abandoning this batch.');
        break;
      }
      if (resp.data.error && resp.data.error.type === 'NOT_ENOUGH_TOKEN') {
        const refillIn = resp.data.refillIn || 20000;
        await sleep(Math.min(refillIn + 1000, 65000));
        continue;
      }
      // A negative balance still comes with valid products — Keepa answers,
      // THEN charges. Throwing them away and asking again paid twice for the
      // same batch. Keep them; the wait below covers the deficit.
      tokensLeft = resp.data.tokensLeft;
      const products = resp.data.products || [];
      const simplified = products.map(simplify);
      for (const p of simplified) out.push(p);
      done = true;
      if (onBatch) {
        try { await onBatch(simplified, { tokensLeft, batchIndex: Math.floor(i/100), done: out.length, total: asins.length }); }
        catch (e) { console.error('[Keepa] onBatch handler failed (non-fatal):', e.message); }
      }

      // if tokens are running low, wait for the bucket to refill before next batch
      // One refill is not enough when a batch costs hundreds of tokens: wait
      // until the balance is back above zero plus a margin (refillRate is
      // tokens per minute).
      if (tokensLeft != null && tokensLeft < 50 && i + 100 < asins.length) {
        const rate = resp.data.refillRate || 0;
        const refillIn = resp.data.refillIn || 15000;
        const waitMs = rate > 0 ? refillIn + Math.max(0, (50 - tokensLeft) / rate) * 60000 : refillIn + 1000;
        if (onProgress && waitMs > 70000) onProgress(`waiting ${Math.round(waitMs/60000)} min for Keepa tokens…`);
        await sleep(Math.min(waitMs, 30 * 60000));
      } else {
        await sleep(1200);
      }
    }
    if (!done) {
      failed.push({ batch: Math.floor(i/100) + 1, asins: batch.length });
      console.error(`[Keepa] batch ${Math.floor(i/100)+1} gave up after retries — continuing with the rest.`);
      if (onProgress) onProgress(`batch ${Math.floor(i/100)+1} failed, continuing…`);
    }
  }
  return { products: out, tokensLeft, failed };
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

  // ---- IS AMAZON SELLING? ----
  // amazonPrice (from stats.current[AMAZON]) is null when Amazon has NO live offer.
  // availabilityAmazon: -1 = no offer, 0 = in stock, >0 = delayed/backordered.
  const availAmz = (p.availabilityAmazon != null) ? p.availabilityAmazon : null;
  const amazonSelling = (amazonPrice != null) && (availAmz !== -1);
  const amazonOutOfStock = (amazonPrice == null) || (availAmz === -1);

  // ---- Amazon fees (for net-deposit calc) ----
  // Keepa returns fbaFees.pickAndPackFee in cents; referralFeePercent as a number (e.g. 15)
  let pickPackFee = null, referralPct = null;
  if (p.fbaFees) {
    const pp = p.fbaFees.pickAndPackFee;
    if (pp != null && pp >= 0) pickPackFee = pp / 100;
  }
  if (p.referralFeePercent != null && p.referralFeePercent > 0) {
    referralPct = p.referralFeePercent;
  } else if (p.referralFeePercentage != null && p.referralFeePercentage > 0) {
    referralPct = p.referralFeePercentage;
  }

  // image: newer Keepa uses images[] array (images[0].l = large filename);
  // older uses imagesCSV. Handle both.
  let image = null;
  if (Array.isArray(p.images) && p.images.length) {
    const im = p.images[0];
    const fn = im.l || im.m || im.large || im.medium;
    if (fn) image = 'https://m.media-amazon.com/images/I/' + fn;
  }
  if (!image && p.imagesCSV) {
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
    pickPackFee, referralPct,
    availabilityAmazon: availAmz, amazonSelling, amazonOutOfStock,
  };
}

module.exports = { getProducts, keyOk };

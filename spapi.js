// ============================================================
// spapi.js — SP-API integration for the inventory app
// Reads FBA inbound shipments; clears in-transit when Amazon
// checks them in (status RECEIVED / CLOSED).
// Uses the same LWA refresh-token auth as your main bot.
// ============================================================
const axios = require('axios');
const qs = require('querystring');

const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

let tokenCache = null;

// Pick ONE complete credential set: all three _FM values, else all three base
// values. Each value used to fall back on its own, so a half-configured _FM
// set could pair the FM client with the main app's refresh token.
function credentials() {
  const e = process.env;
  const fm = [e.AMAZON_CLIENT_ID_FM, e.AMAZON_CLIENT_SECRET_FM, e.AMAZON_REFRESH_TOKEN_FM];
  const base = [e.AMAZON_CLIENT_ID, e.AMAZON_CLIENT_SECRET, e.AMAZON_REFRESH_TOKEN];
  const fmSet = fm.filter(Boolean).length;
  if (fmSet === 3) return { set: '_FM', clientId: fm[0], clientSecret: fm[1], refreshToken: fm[2] };
  if (fmSet > 0) {
    // Mixed sets usually fail with invalid_grant, but this is how it always
    // behaved — don't break a setup that happens to work. Say so loudly.
    if (!credentials._warned) { credentials._warned = true;
      console.warn('[SP-API] WARNING: only some AMAZON_*_FM variables are set; mixing them with the base set. If calls fail with invalid_grant, set all three _FM values or none.'); }
    const pick = (i) => fm[i] || base[i];
    if (![0, 1, 2].every(pick)) throw new Error('SP-API credentials not set (AMAZON_CLIENT_ID / SECRET / REFRESH_TOKEN)');
    return { set: 'mixed', clientId: pick(0), clientSecret: pick(1), refreshToken: pick(2) };
  }
  if (base.every(Boolean)) return { set: 'base', clientId: base[0], clientSecret: base[1], refreshToken: base[2] };
  throw new Error('SP-API credentials not set (AMAZON_CLIENT_ID / SECRET / REFRESH_TOKEN)');
}

async function getAccessToken() {
  // Five minutes' margin: long scans fetch a token per request (see http
  // below), and a token that is about to lapse mid-request is no good.
  if (tokenCache && tokenCache.expiry && Date.now() < tokenCache.expiry - 5 * 60000) {
    return tokenCache.token;
  }
  const c = credentials();
  const resp = await http.post('https://api.amazon.com/auth/o2/token',
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  if (!tokenCache) console.log(`[SP-API] using the ${c.set} credential set.`);
  tokenCache = { token: resp.data.access_token, expiry: Date.now() + resp.data.expires_in * 1000 };
  return resp.data.access_token;
}

// Every SP-API call goes through this client:
//  - a timeout, so a hung connection can't freeze a background job (and its
//    "running" flag) until the next restart;
//  - a fresh access token on every request. Functions fetch one token at the
//    start and loop for up to an hour; after it expired every remaining call
//    got 403 and prices / hazmat flags silently came back blank;
//  - one retry with a new token if Amazon says the token is bad.
const http = axios.create({ timeout: 90000 });
http.interceptors.request.use(async (config) => {
  if (String(config.url || '').startsWith(SP_API_BASE)) {
    config.headers = config.headers || {};
    config.headers['x-amz-access-token'] = await getAccessToken();
  }
  return config;
});
http.interceptors.response.use(null, async (err) => {
  const cfg = err.config;
  const body = JSON.stringify(err.response?.data || '');
  if (cfg && !cfg._tokenRetry && err.response?.status === 403 &&
      String(cfg.url || '').startsWith(SP_API_BASE) && /expired|Unauthorized|access token/i.test(body)) {
    cfg._tokenRetry = true;
    tokenCache = null;
    return http(cfg);
  }
  throw err;
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Put a throttled ASIN back on the end of the list, at most five times. It
// used to be re-queued without limit, so a sustained 429 looped for ever.
function requeue(list, asin) {
  const tries = list._tries || (list._tries = {});
  tries[asin] = (tries[asin] || 0) + 1;
  if (tries[asin] > 5) return false;
  list.push(asin);
  return true;
}

// List inbound shipments updated recently, filtered to RECEIVED/CLOSED
async function getReceivedShipments(sinceDays = 45) {
  return listInboundShipments(sinceDays, ['RECEIVING', 'CLOSED']);
}

async function listInboundShipments(sinceDays, statuses) {
  const token = await getAccessToken();
  const after = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const before = new Date().toISOString();

  const results = [];
  let nextToken = null;

  do {
    const params = { MarketplaceId: MARKETPLACE_ID };
    if (nextToken) {
      params.QueryType = 'NEXT_TOKEN';
      params.NextToken = nextToken;
    } else {
      params.QueryType = 'DATE_RANGE';
      params.LastUpdatedAfter = after;
      params.LastUpdatedBefore = before;
      // ShipmentStatusList must be repeated params: ?ShipmentStatusList=WORKING&ShipmentStatusList=...
      params.ShipmentStatusList = statuses;
    }

    let resp;
    try {
      resp = await http.get(`${SP_API_BASE}/fba/inbound/v0/shipments`, {
        headers: { 'x-amz-access-token': token },
        params,
        // serialize arrays as repeated keys (SP-API requirement)
        paramsSerializer: p => {
          const parts = [];
          for (const k in p) {
            const v = p[k];
            if (Array.isArray(v)) v.forEach(x => parts.push(`${k}=${encodeURIComponent(x)}`));
            else parts.push(`${k}=${encodeURIComponent(v)}`);
          }
          return parts.join('&');
        }
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error('[SP-API] shipments list failed:', err.response?.status, body);
      throw new Error(`SP-API ${err.response?.status}: ${body}`);
    }

    const shipments = resp.data.payload?.ShipmentData || [];
    for (const s of shipments) results.push(s);
    nextToken = resp.data.payload?.NextToken || null;
    await sleep(1200); // rate-limit friendly
  } while (nextToken);

  return results;
}

// Units on their way to Amazon, per seller SKU, straight from the open
// shipments: shipped minus received for every shipment not yet closed. This
// is what Seller Central shows as "Receiving… 288 / 0". The inventory
// summary's inbound figures can lag or miss a shipment at that stage (a duo
// read 0 on the way while 288 were receiving), so this is the figure to trust.
const OPEN_SHIPMENT_STATUSES = ['WORKING', 'READY_TO_SHIP', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CHECKED_IN', 'RECEIVING'];
async function getInboundPipeline(sinceDays = 180, onProgress) {
  const shipments = await listInboundShipments(sinceDays, OPEN_SHIPMENT_STATUSES);
  const bySku = {};
  let n = 0;
  for (const sh of shipments) {
    n++;
    if (onProgress) onProgress(`Checking open shipment ${n} of ${shipments.length} (${sh.ShipmentId})…`);
    const items = await getShipmentReceivedItems(sh.ShipmentId);
    for (const it of items) {
      const left = Math.max(0, (it.shipped || 0) - (it.received || 0));
      if (!it.sku || !left) continue;
      const r = bySku[it.sku] = bySku[it.sku] || { qty: 0, shipments: [] };
      r.qty += left;
      r.shipments.push({ id: sh.ShipmentId, name: sh.ShipmentName || '', status: sh.ShipmentStatus || '', qty: left });
    }
  }
  return { bySku, shipmentCount: shipments.length };
}

// For one shipment, get the per-SKU RECEIVED quantities
async function getShipmentReceivedItems(shipmentId) {
  const token = await getAccessToken();
  const items = [];
  const seenSku = new Set(), seenTokens = new Set();
  let nextToken = null, pages = 0;

  do {
    const params = { MarketplaceId: MARKETPLACE_ID, QueryType: nextToken ? 'NEXT_TOKEN' : 'SHIPMENT' };
    if (nextToken) params.NextToken = nextToken;

    let resp;
    try {
      resp = await http.get(`${SP_API_BASE}/fba/inbound/v0/shipments/${shipmentId}/items`, {
        headers: { 'x-amz-access-token': token },
        params,
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[SP-API] items for ${shipmentId} failed:`, err.response?.status, body);
      // Throw: an empty or partial list used to read as "everything received"
      // and closed the shipment for good with no shortage flagged.
      throw new Error(`SP-API items for ${shipmentId}: ${err.response?.status || ''} ${body}`);
    }

    const data = resp.data.payload?.ItemData || [];
    let fresh = 0;
    for (const it of data) {
      // One row per SKU per shipment. A repeated SKU means Amazon sent the
      // same page again — don't count it twice.
      if (seenSku.has(it.SellerSKU)) continue;
      seenSku.add(it.SellerSKU); fresh++;
      items.push({
        sku: it.SellerSKU,
        received: it.QuantityReceived || 0,
        shipped: it.QuantityShipped || 0,
      });
    }
    // This endpoint can hand back a NextToken it then ignores, returning the
    // first page for ever — a sync sat on "shipment 1 of 2" for minutes,
    // calling Amazon every second. Stop on a repeated token, a page with
    // nothing new, or after 20 pages.
    const tok = resp.data.payload?.NextToken || null;
    pages++;
    nextToken = (tok && !seenTokens.has(tok) && fresh > 0 && pages < 20) ? tok : null;
    if (tok) seenTokens.add(tok);
    await sleep(1200);
  } while (nextToken);

  return items;
}

// Get current FBA inventory (what Amazon holds) via FBA Inventory API
async function getFbaInventory(onProgress, sellerSkus) {
  const token = await getAccessToken();
  const results = {};
  let nextToken = null, pages = 0;
  do {
    const params = {
      granularityType: 'Marketplace',
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,
      details: true,
    };
    // Look up specific SKUs only (the "Check with Amazon" button); max 50.
    if (sellerSkus && sellerSkus.length) params.sellerSkus = sellerSkus.slice(0, 50).join(',');
    if (nextToken) params.nextToken = nextToken;
    let resp;
    try {
      resp = await http.get(`${SP_API_BASE}/fba/inventory/v1/summaries`, {
        headers: { 'x-amz-access-token': token }, params,
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`FBA inventory ${err.response?.status}: ${body}`);
    }
    const sums = resp.data.payload?.inventorySummaries || [];
    pages++;
    if (onProgress) onProgress(`Reading Amazon stock — ${Object.keys(results).length + sums.length} SKUs so far…`);
    for (const s of sums) {
      results[s.sellerSku] = {
        sku: s.sellerSku, asin: s.asin, fnSku: s.fnSku,
        total: s.totalQuantity || 0,
        fulfillable: s.inventoryDetails?.fulfillableQuantity || 0,
        inbound: (s.inventoryDetails?.inboundWorkingQuantity||0) + (s.inventoryDetails?.inboundShippedQuantity||0) + (s.inventoryDetails?.inboundReceivingQuantity||0),
        // What Seller Central calls "On-hand (FBA)": everything physically at
        // Amazon — available plus reserved/being processed. totalQuantity also
        // counts units in shipments (working, shipped and receiving), so all
        // of those come off. Leaving 'working' in showed 1078 for a product
        // with 434 available and 588 on the way.
        onHand: Math.max(s.inventoryDetails?.fulfillableQuantity || 0,
          (s.totalQuantity || 0) - (s.inventoryDetails?.inboundWorkingQuantity || 0)
            - (s.inventoryDetails?.inboundShippedQuantity || 0) - (s.inventoryDetails?.inboundReceivingQuantity || 0)),
      };
    }
    // Amazon puts the next-page token in a top-level "pagination" object, not
    // in payload. Reading only payload.nextToken stopped after the first page
    // (50 SKUs), so every product past it — many of the duos — showed 0 at
    // Amazon and never had its FNSKU picked up.
    nextToken = resp.data.pagination?.nextToken || resp.data.payload?.nextToken || null;
    await sleep(1000);
  } while (nextToken);
  // Not enumerable, so callers looping over SKUs never see it.
  Object.defineProperty(results, '_pages', { value: pages, enumerable: false });
  return results;
}

// Sales velocity via the ALL ORDERS report (one report, not per-order calls = fast)
async function getSalesVelocity(days = 30) {
  const token = await getAccessToken();
  const zlib = require('zlib');
  const after = new Date(Date.now() - days*24*60*60*1000).toISOString();

  // 1. Request the flat-file all-orders report
  const createResp = await http.post(`${SP_API_BASE}/reports/2021-06-30/reports`, {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    marketplaceIds: [MARKETPLACE_ID],
    dataStartTime: after,
  }, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });

  const reportId = createResp.data.reportId;
  // 2. Poll for completion (up to ~90s)
  let docId = null;
  for (let i=0;i<18;i++){
    await sleep(5000);
    const st = await http.get(`${SP_API_BASE}/reports/2021-06-30/reports/${reportId}`, { headers:{'x-amz-access-token':token} });
    const status = st.data.processingStatus;
    if (status==='DONE'){ docId = st.data.reportDocumentId; break; }
    if (status==='CANCELLED'||status==='FATAL') throw new Error('Report '+status);
  }
  if(!docId) throw new Error('Report timed out — try again in a moment');

  // 3. Download + parse
  const doc = await http.get(`${SP_API_BASE}/reports/2021-06-30/documents/${docId}`, { headers:{'x-amz-access-token':token} });
  const dl = await http.get(doc.data.url, { responseType:'arraybuffer' });
  let body = doc.data.compressionAlgorithm==='GZIP' ? zlib.gunzipSync(Buffer.from(dl.data)).toString('utf-8') : Buffer.from(dl.data).toString('utf-8');

  const lines = body.split(/\r?\n/).filter(l=>l);
  if(!lines.length) return {};
  const headers = lines[0].split('\t');
  const skuIdx = headers.indexOf('sku');
  const qtyIdx = headers.indexOf('quantity');
  const statusIdx = headers.indexOf('item-status');
  // The report selects orders by LAST UPDATE. An order placed before the
  // window but shipped/refunded inside it was counted, inflating velocity.
  const dateIdx = headers.indexOf('purchase-date');
  const afterMs = Date.parse(after);
  const skuUnits = {};
  for(let i=1;i<lines.length;i++){
    const c = lines[i].split('\t');
    const sku = c[skuIdx];
    const qty = parseInt(c[qtyIdx])||0;
    const st = (c[statusIdx]||'').toLowerCase();
    if(!sku || qty<=0 || st==='cancelled') continue;
    if(dateIdx >= 0){ const pd = Date.parse(c[dateIdx]); if(!isNaN(pd) && pd < afterMs) continue; }
    skuUnits[sku] = (skuUnits[sku]||0) + qty;
  }
  return skuUnits;
}

// Amazon's restock recommendation (Seller Central → Restock Inventory), raw
// tab-separated text; lib/restock.js parses it. Same create/poll/download
// flow as the sales report. Errors are thrown, never returned as empty.
async function getRestockReport() {
  const token = await getAccessToken();
  const createResp = await http.post(`${SP_API_BASE}/reports/2021-06-30/reports`, {
    reportType: 'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
    marketplaceIds: [MARKETPLACE_ID],
  }, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });
  const reportId = createResp.data.reportId;
  let docId = null;
  for (let i = 0; i < 24; i++) {   // up to ~2 minutes
    await sleep(5000);
    const st = await http.get(`${SP_API_BASE}/reports/2021-06-30/reports/${reportId}`, { headers: { 'x-amz-access-token': await getAccessToken() } });
    const status = st.data.processingStatus;
    if (status === 'DONE') { docId = st.data.reportDocumentId; break; }
    if (status === 'CANCELLED' || status === 'FATAL') throw new Error('Restock report ' + status);
  }
  if (!docId) throw new Error('Restock report timed out');
  return downloadReportDocument(docId);
}

// Get Amazon prices per ASIN. Uses the getItemOffers endpoint per-ASIN which is
// more reliable for returning a current price than the batch price endpoint.
// Returns { asin: price }. Also returns diagnostics via a global.
async function getMyPrices(asins, onProgress) {
  const token = await getAccessToken();
  const prices = {};
  const unique = [...new Set(asins.filter(Boolean))];
  let errors = 0, noPrice = 0, ok = 0;
  for (const asin of unique) {
    let attempt = 0;
    let done = false;
    while (attempt < 4 && !done) {
      try {
        const resp = await http.get(
          `${SP_API_BASE}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${MARKETPLACE_ID}&ItemCondition=New`,
          { headers: { 'x-amz-access-token': token } });
        const payload = resp.data.payload || {};
        let amt = null;
        const bb = payload.Summary?.BuyBoxPrices?.[0];
        if (bb) amt = bb.ListingPrice?.Amount;
        if (!amt) { const lp = payload.Summary?.LowestPrices?.[0]; if (lp) amt = lp.ListingPrice?.Amount; }
        if (!amt && payload.Offers?.length) amt = payload.Offers[0].ListingPrice?.Amount;
        if (amt) { prices[asin] = amt; ok++; } else { noPrice++; }
        done = true;
      } catch(e) {
        if (e.response?.status === 429) {
          // rate limited — back off and retry
          attempt++;
          await sleep(3000 * attempt); // 3s, 6s, 9s...
        } else {
          errors++;
          if (errors <= 3) console.error('[Pricing]', asin, e.response?.status, JSON.stringify(e.response?.data||e.message).slice(0,200));
          done = true;
        }
      }
    }
    if (!done) errors++; // exhausted retries
    await sleep(2100); // ~0.47/sec — under Amazon's getItemOffers limit
  }
  console.log(`[Pricing] Done: ${ok} priced, ${noPrice} no-price, ${errors} errors of ${unique.length}`);
  return prices;
}

// Get product images via Catalog Items API (2022-04-01). Returns { asin: imageUrl }.
async function getCatalogImages(asins) {
  const token = await getAccessToken();
  const images = {};
  const unique = [...new Set(asins.filter(Boolean))];
  for (const asin of unique) {
    try {
      const url = `${SP_API_BASE}/catalog/2022-04-01/items/${asin}?marketplaceIds=${MARKETPLACE_ID}&includedData=images`;
      const resp = await http.get(url, { headers: { 'x-amz-access-token': token } });
      // images come back as images[].images[] with variant + link
      const imgGroups = resp.data.images || [];
      let bestUrl = null;
      for (const g of imgGroups) {
        const imgs = g.images || [];
        // prefer MAIN variant, largest
        const main = imgs.find(i => i.variant === 'MAIN') || imgs[0];
        if (main && main.link) { bestUrl = main.link; break; }
      }
      if (bestUrl) images[asin] = bestUrl;
    } catch(e) {
      // skip individual failures
    }
    await sleep(600); // Catalog Items rate limit ~2/sec
  }
  return images;
}

// LIVE offer check per ASIN — accurate "is Amazon actually selling right now?"
// Amazon's own seller id on the US marketplace is ATVPDKIKX0DER.
const AMAZON_SELLER_ID = 'ATVPDKIKX0DER';
async function getLiveOffers(asins, onProgress) {
  const token = await getAccessToken();
  const out = {};
  let i = 0;
  for (const asin of asins) {
    i++;
    if (onProgress && i % 10 === 0) onProgress(`checking ${i} of ${asins.length} listings…`);
    try {
      const resp = await http.get(
        `${SP_API_BASE}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${MARKETPLACE_ID}&ItemCondition=New`,
        { headers: { 'x-amz-access-token': token } }
      );
      const payload = resp.data.payload || {};
      const offers = payload.Offers || [];
      const summary = payload.Summary || {};

      // Is Amazon (the retailer) among the live offers?
      const amazonOffer = offers.find(o => o.SellerId === AMAZON_SELLER_ID);
      // Who currently holds the buy box?
      const bbOffer = offers.find(o => o.IsBuyBoxWinner === true);
      const bbSeller = bbOffer ? bbOffer.SellerId : null;
      // Our own offer is flagged MyOffer — that's how we learn our seller id.
      const mine = offers.find(o => o.MyOffer === true);

      out[asin] = {
        amazonSelling: !!amazonOffer,                       // LIVE: Amazon has an offer
        amazonHasBuyBox: bbSeller === AMAZON_SELLER_ID,
        buyBoxExists: !!bbOffer,
        buyBoxPrice: bbOffer?.ListingPrice?.Amount ?? null,
        buyBoxIsFba: bbOffer?.IsFulfilledByAmazon ?? null,
        totalOffers: summary.TotalOfferCount ?? offers.length,
        lowestPrice: summary.LowestPrices?.[0]?.ListingPrice?.Amount ?? null,
        mySellerId: mine ? mine.SellerId : null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      const st = err.response?.status;
      if (st === 429 && requeue(asins, asin)) { await sleep(4000); continue; }  // retry later
      out[asin] = { error: err.response?.data?.errors?.[0]?.message || err.message };
    }
    await sleep(2100);  // ~0.47/sec, under Amazon's getItemOffers limit
  }
  return out;
}

// Current Amazon title (and main image) per ASIN.
// Product names in inv_products are frozen from the original seed file, but
// brands rewrite listings — "The Original Leave-In Conditioner" is now titled
// "The Conditioner". A stale title breaks description matching on invoices, so
// this pulls the live title straight from the Catalog Items API.
async function getCatalogItems(asins, onProgress) {
  const token = await getAccessToken();
  const out = {};
  const unique = [...new Set(asins.filter(Boolean))];
  let i = 0;
  for (const asin of unique) {
    i++;
    if (onProgress && i % 5 === 0) onProgress(`${i} of ${unique.length} looked up…`);
    try {
      const url = `${SP_API_BASE}/catalog/2022-04-01/items/${asin}?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,images`;
      const resp = await http.get(url, { headers: { 'x-amz-access-token': token } });

      const sum = (resp.data.summaries || [])[0] || {};
      const name = sum.itemName || null;
      const brand = sum.brand || null;

      let image = null;
      for (const g of (resp.data.images || [])) {
        const imgs = g.images || [];
        const main = imgs.find(x => x.variant === 'MAIN') || imgs[0];
        if (main && main.link) { image = main.link; break; }
      }
      if (name || image) out[asin] = { asin, name, brand, image };
    } catch (e) {
      const st = e.response?.status;
      if (st === 429 && requeue(unique, asin)) { await sleep(3000); continue; }  // retry later
      out[asin] = { asin, error: e.response?.data?.errors?.[0]?.message || e.message };
    }
    await sleep(600); // Catalog Items rate limit ~2/sec
  }
  return out;
}

// Package / item dimensions per ASIN (Catalog Items `dimensions`), for FBA
// capacity (lib/capacity.js turns them into cubic feet). Returns
// { asin: { dimensions } | { error } } — an error is kept per ASIN, never
// turned into "no size", so a failed lookup can be retried.
async function getItemDimensions(asins, onProgress) {
  const out = {};
  const unique = [...new Set(asins.filter(Boolean))];
  let i = 0;
  for (const asin of unique) {
    i++;
    if (onProgress && i % 5 === 0) onProgress(`${i} of ${unique.length} sizes looked up…`);
    try {
      const token = await getAccessToken();
      const resp = await http.get(`${SP_API_BASE}/catalog/2022-04-01/items/${asin}?marketplaceIds=${MARKETPLACE_ID}&includedData=dimensions`,
        { headers: { 'x-amz-access-token': token } });
      const d = (resp.data.dimensions || []).find(x => x.marketplaceId === MARKETPLACE_ID) || (resp.data.dimensions || [])[0] || null;
      out[asin] = { dimensions: d };
    } catch (e) {
      const st = e.response?.status;
      if (st === 429 && requeue(unique, asin)) { await sleep(3000); continue; }
      out[asin] = { error: e.response?.data?.errors?.[0]?.message || e.message };
    }
    await sleep(600); // Catalog Items rate limit ~2/sec
  }
  return out;
}

// Hazmat / dangerous-goods status per ASIN.
// Two independent sources, because neither is populated for every listing:
//   1. Catalog Items attributes -> supplier_declared_dg_hz_regulation
//      (the seller-declared dangerous-goods regulation; "not_applicable" = clean)
//   2. FBA Inbound Eligibility -> ineligibility reasons mentioning hazmat
// Returns { asin: { hazmat: true|false|null, detail, source } }. null = unknown,
// which is deliberately NOT treated as safe.
async function getHazmatStatus(asins, onProgress) {
  const token = await getAccessToken();
  const out = {};
  const unique = [...new Set(asins.filter(Boolean))];
  let i = 0;

  for (const asin of unique) {
    i++;
    if (onProgress && i % 5 === 0) onProgress(`${i} of ${unique.length} checked…`);
    let hazmat = null, detail = '', source = '';

    // --- 1. seller-declared dangerous goods on the listing ---
    try {
      const url = `${SP_API_BASE}/catalog/2022-04-01/items/${asin}?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`;
      const r = await http.get(url, { headers: { 'x-amz-access-token': token } });
      const attrs = r.data.attributes || {};
      const dg = attrs.supplier_declared_dg_hz_regulation;
      if (Array.isArray(dg) && dg.length) {
        const vals = dg.map(x => String(x.value || '').toLowerCase()).filter(Boolean);
        if (vals.length) {
          const clean = vals.every(v => v === 'not_applicable' || v === 'none');
          hazmat = !clean;
          detail = vals.join(', ');
          source = 'amazon-dg';
        }
      }
    } catch (e) {
      if (e.response?.status === 429 && requeue(unique, asin)) { await sleep(3000); continue; }
    }
    await sleep(600);

    // --- 2. inbound eligibility, when the listing declared nothing ---
    if (hazmat === null) {
      try {
        const url = `${SP_API_BASE}/fba/inbound/v1/eligibility/itemPreview?marketplaceIds=${MARKETPLACE_ID}&program=INBOUND&asinList=${asin}`;
        const r = await http.get(url, { headers: { 'x-amz-access-token': token } });
        const items = r.data.payload || [];
        const it = Array.isArray(items) ? items[0] : items;
        if (it) {
          const reasons = (it.ineligibilityReasonList || []).map(x => String(x).toUpperCase());
          const haz = reasons.filter(x => /HAZMAT|DANGEROUS|FLAMMABLE|AEROSOL/.test(x));
          if (haz.length) { hazmat = true; detail = haz.join(', '); source = 'amazon-inbound'; }
          else if (it.isEligibleForProgram === true) { hazmat = false; detail = 'inbound eligible'; source = 'amazon-inbound'; }
        }
      } catch (e) { /* endpoint not available on every account — leave unknown */ }
      await sleep(600);
    }

    out[asin] = { asin, hazmat, detail, source };
  }
  return out;
}

// ============================================================
// SETTLEMENT REPORTS — the actual money
// Keepa gives an ESTIMATE of referral and FBA fees. The settlement report is
// what Amazon really deposited: principal, every fee by name, refunds, refund
// commissions, storage, and adjustments. These reports are generated by Amazon
// on its own disbursement schedule and CANNOT be requested on demand — they
// are listed, then downloaded.
// ============================================================
// Order matters. On this account the _V2 variant returns 403 Unauthorized while
// the plain flat file works, so the working type is tried FIRST — three wasted
// calls per run is three minutes of a one-per-minute rate budget.
const SETTLEMENT_TYPES = [
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE',
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2'
];

// Returns { reports, attempts } — attempts records what each variation actually
// did, so an empty result can be diagnosed instead of guessed at.
async function listSettlementReports(sinceDays = 180) {
  console.log(`[Settlement] listing reports for the last ${sinceDays} days…`);
  const token = await getAccessToken();
  const after = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
  const found = [];
  const attempts = [];

  const serialize = p => Object.entries(p)
    .map(([k, v]) => Array.isArray(v) ? v.map(x => `${k}=${encodeURIComponent(x)}`).join('&')
                                      : `${k}=${encodeURIComponent(v)}`).join('&');

  for (const rt of SETTLEMENT_TYPES) {
    // Settlement reports are SCHEDULED, created by Amazon on its own cadence.
    // Filtering them by dataStartTime frequently returns nothing, so try the
    // plain listing first and only then the date-filtered variant.
    // Without createdSince, getReports only looks back 90 days — a 180- or
    // 365-day request silently came back with ~90 days. Ask for the full
    // window first; the older shapes remain as fallbacks.
    const variants = [
      { label: 'created since',    params: { reportTypes: rt, createdSince: after, pageSize: 100 } },
      { label: 'no date filter',   params: { reportTypes: rt, pageSize: 100 } },
      { label: 'DONE only',        params: { reportTypes: rt, processingStatuses: 'DONE', pageSize: 100 } },
      { label: 'date filtered',    params: { reportTypes: rt, processingStatuses: 'DONE', dataStartTime: after, pageSize: 100 } }
    ];

    for (const v of variants) {
      let nextToken = null, pages = 0, seen = 0, err = null;
      do {
        let resp;
        try {
          resp = await http.get(`${SP_API_BASE}/reports/2021-06-30/reports`, {
            headers: { 'x-amz-access-token': token },
            params: nextToken ? { nextToken } : v.params,
            paramsSerializer: serialize
          });
        } catch (e) {
          const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 220) : String(e.message);
          err = `HTTP ${e.response?.status || '?'} ${body}`;
          console.error(`[Settlement] LIST FAILED ${rt} (${v.label}): ${err}`);
          break;
        }
        const list = resp.data.reports || [];
        seen += list.length;
        for (const r of list) {
          if (r.reportDocumentId && !found.some(f => f.reportId === r.reportId)) {
            found.push({ reportId: r.reportId, reportType: r.reportType,
                         documentId: r.reportDocumentId, start: r.dataStartTime, end: r.dataEndTime });
          }
        }
        nextToken = resp.data.nextToken || null;
        pages++;
        await sleep(1200);
      } while (nextToken && pages < 10);

      attempts.push({ reportType: rt, variant: v.label, seen, withDocs: found.length, error: err });
      console.log(`[Settlement] list ${rt} (${v.label}): ${seen} report(s) seen, ${found.length} with documents${err ? ' — ' + err : ''}`);
      if (found.length) break;
      // A 403 means this report type is not available on the account at all —
      // trying other query shapes against it just burns the rate budget.
      if (err && /403|Unauthorized|forbidden/i.test(err)) {
        console.log(`[Settlement] ${rt} is not permitted on this account — skipping its remaining query variants.`);
        break;
      }
    }
    if (found.length) break;
  }
  console.log(`[Settlement] listing done: ${found.length} report(s) with documents across ${attempts.length} attempt(s).`);
  return { reports: found, attempts };
}

// getReportDocument is one of the most throttled calls in SP-API — roughly one
// request per MINUTE after a small burst. Hammering it just returns 429 after
// 429, so back off properly and honour the rate-limit header when present.
async function downloadReportDocument(documentId, onProgress) {
  const zlib = require('zlib');
  // Repeated 429s after two-minute waits mean the token bucket is drained, not
  // merely paced — and every retry keeps it empty. Back off hard and long.
  const waits = [60000, 150000, 300000, 600000];   // 1m, 2.5m, 5m, 10m

  for (let attempt = 0; attempt <= waits.length; attempt++) {
    const token = await getAccessToken();
    try {
      const doc = await http.get(`${SP_API_BASE}/reports/2021-06-30/documents/${documentId}`,
        { headers: { 'x-amz-access-token': token } });
      const dl = await http.get(doc.data.url, { responseType: 'arraybuffer' });
      return doc.data.compressionAlgorithm === 'GZIP'
        ? zlib.gunzipSync(Buffer.from(dl.data)).toString('utf-8')
        : Buffer.from(dl.data).toString('utf-8');
    } catch (e) {
      const st = e.response?.status;
      const h = e.response?.headers || {};
      if (st === 429) {
        // Log exactly what Amazon said, so this is diagnosable rather than guessed at.
        console.log('[Settlement] 429 detail:',
          'rateLimit=' + (h['x-amzn-ratelimit-limit'] || 'none'),
          'retryAfter=' + (h['retry-after'] || 'none'),
          'requestId=' + (h['x-amzn-requestid'] || h['x-amzn-request-id'] || 'none'));
      }
      if (st !== 429 || attempt === waits.length) throw e;
      const retryAfter = parseFloat(h['retry-after'] || '');
      const hdrRate = parseFloat(h['x-amzn-ratelimit-limit'] || '');
      let wait = waits[attempt];
      if (retryAfter > 0) wait = Math.max(wait, Math.ceil(retryAfter * 1000) + 3000);
      else if (hdrRate > 0 && hdrRate < 1) wait = Math.max(wait, Math.ceil(1000 / hdrRate) + 5000);
      const secs = Math.round(wait / 1000);
      console.log(`[Settlement] rate limited, waiting ${secs}s (attempt ${attempt + 1} of ${waits.length})`);
      if (onProgress) onProgress(`Amazon rate limit — waiting ${secs}s (attempt ${attempt + 1})`);
      await sleep(wait);
    }
  }
  throw new Error('rate limited after extended backoff');
}

// ============================================================
// Inbound fees — Fulfillment Inbound API v2024-03-20 ("Send to Amazon").
// For each inbound plan: the ACCEPTED placement option's fees (placement
// service fee, less any discount), and for each shipment the SELECTED
// transportation option's quote (Amazon partnered carrier cost).
// Plans created in the older workflow aren't visible here; those shipments
// simply won't come back, and can still be entered by hand.
// ============================================================
const INB = `${SP_API_BASE}/inbound/fba/2024-03-20`;
async function inbGet(path, token, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await http.get(INB + path, { headers: { 'x-amz-access-token': token }, params });
      await sleep(600);
      return r.data;
    } catch (e) {
      const st = e.response?.status;
      if (st === 429 && attempt < 4) { await sleep(2000 * (attempt + 1)); continue; }
      const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
      throw new Error(`Inbound API ${st || ''} on ${path}: ${body}`);
    }
  }
}
const money = v => (v && v.amount != null ? Number(v.amount) : 0);

async function getInboundFees(sinceDays = 180, onProgress) {
  const token = await getAccessToken();
  const cutoff = Date.now() - sinceDays * 86400000;
  const say = m => { if (onProgress) onProgress(m); console.log('[InboundFees] ' + m); };

  // 1. plans, newest first, until older than the cutoff. Amazon lists plans by
  //    status, and without a status only in-progress (ACTIVE) plans come back —
  //    finished ones are SHIPPED. Ask for both and merge.
  const plans = [], seen = new Set();
  for (const status of ['SHIPPED', 'ACTIVE']) {
    let next = null, pages = 0, n = 0;
    do {
      const d = await inbGet('/inboundPlans', token,
        { pageSize: 30, status, sortBy: 'CREATION_TIME', sortOrder: 'DESC', ...(next ? { paginationToken: next } : {}) });
      const batch = d.inboundPlans || [];
      let tooOld = false;
      for (const p of batch) {
        if (new Date(p.createdAt).getTime() < cutoff) { tooOld = true; break; }
        if (seen.has(p.inboundPlanId)) continue;
        seen.add(p.inboundPlanId); plans.push(p); n++;
      }
      next = tooOld ? null : (d.pagination && d.pagination.nextToken) || null;
      pages++;
    } while (next && pages < 20);
    say(`${n} ${status.toLowerCase()} plan(s)`);
  }
  plans.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  say(`${plans.length} inbound plan(s) in the last ${sinceDays} days`);

  const out = [];
  let i = 0;
  for (const plan of plans) {
    i++;
    say(`plan ${i}/${plans.length} — ${plan.name || plan.inboundPlanId}`);
    try {
      const detail = await inbGet(`/inboundPlans/${plan.inboundPlanId}`, token);
      // accepted placement option and its fees
      let placementTotal = 0, placementShipments = [], placementLines = [];
      try {
        const po = await inbGet(`/inboundPlans/${plan.inboundPlanId}/placementOptions`, token);
        const acc = (po.placementOptions || []).find(o => o.status === 'ACCEPTED');
        if (acc) {
          for (const f of (acc.fees || [])) { placementTotal += money(f.value); placementLines.push({ label: f.target || f.description || 'fee', amount: money(f.value) }); }
          for (const dsc of (acc.discounts || [])) { placementTotal -= money(dsc.value); placementLines.push({ label: 'discount: ' + (dsc.target || dsc.description || ''), amount: -money(dsc.value) }); }
          placementShipments = acc.shipmentIds || [];
        }
      } catch (e) { say('  placement options unavailable: ' + e.message); }

      const shipIds = placementShipments.length ? placementShipments : (detail.shipments || []).map(x => x.shipmentId);
      const ships = [];
      for (const sid of shipIds) {
        let sh = {}, units = 0, freight = null, carrier = null, solution = null;
        try { sh = await inbGet(`/inboundPlans/${plan.inboundPlanId}/shipments/${sid}`, token); } catch (e) { say('  shipment unavailable: ' + e.message); }
        try {
          const it = await inbGet(`/inboundPlans/${plan.inboundPlanId}/shipments/${sid}/items`, token);
          units = (it.items || []).reduce((n, x) => n + (Number(x.quantity) || 0), 0);
        } catch (e) {}
        try {
          const tr = await inbGet(`/inboundPlans/${plan.inboundPlanId}/transportationOptions`, token, { shipmentId: sid });
          const chosen = (tr.transportationOptions || []).find(o => o.transportationOptionId === sh.selectedTransportationOptionId);
          if (chosen) {
            solution = chosen.shippingSolution || null;
            carrier = (chosen.carrier && (chosen.carrier.name || chosen.carrier.alphaCode)) || null;
            if (chosen.quote && chosen.quote.cost) freight = money(chosen.quote.cost);
          }
        } catch (e) {}
        ships.push({ internalId: sid, shipmentId: sh.shipmentConfirmationId || null, name: sh.name || null,
                     status: sh.status || null, units, freight, carrier, solution });
      }
      // one placement fee per plan: spread across its shipments by units
      const totalUnits = ships.reduce((n, x) => n + x.units, 0);
      for (const x of ships) {
        x.placement = placementTotal ? (totalUnits ? placementTotal * x.units / totalUnits : placementTotal / ships.length) : 0;
        x.placement = Math.round(x.placement * 100) / 100;
      }
      const note = !ships.length ? (plan.status === 'ACTIVE' ? 'draft — no shipments created yet' : 'no shipments returned') : null;
      out.push({ inboundPlanId: plan.inboundPlanId, planName: plan.name, createdAt: plan.createdAt, status: plan.status,
                 placementTotal: Math.round(placementTotal * 100) / 100, placementLines, shipments: ships, note });
    } catch (e) {
      // Amazon won't read AWD (Warehousing & Distribution) plans through this API.
      if (/Warehousing and Distribution/i.test(e.message)) {
        out.push({ inboundPlanId: plan.inboundPlanId, planName: plan.name, createdAt: plan.createdAt, status: plan.status,
                   note: 'AWD plan — Amazon doesn\'t expose these here; its fees come through settlements', shipments: [] });
        continue;
      }
      say('  plan failed: ' + e.message);
      out.push({ inboundPlanId: plan.inboundPlanId, planName: plan.name, createdAt: plan.createdAt, status: plan.status, error: e.message, shipments: [] });
    }
  }
  return out;
}

module.exports = { getInboundPipeline, getInboundFees, listSettlementReports, downloadReportDocument, getHazmatStatus, getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity, getRestockReport, getMyPrices, getCatalogImages, getCatalogItems, getItemDimensions, getLiveOffers };

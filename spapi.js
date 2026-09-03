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

async function getAccessToken() {
  if (tokenCache && tokenCache.expiry && Date.now() < tokenCache.expiry - 60000) {
    return tokenCache.token;
  }
  const clientId = process.env.AMAZON_CLIENT_ID_FM || process.env.AMAZON_CLIENT_ID;
  const clientSecret = process.env.AMAZON_CLIENT_SECRET_FM || process.env.AMAZON_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN_FM || process.env.AMAZON_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('SP-API credentials not set (AMAZON_CLIENT_ID_FM / SECRET / REFRESH_TOKEN)');
  }

  const resp = await axios.post('https://api.amazon.com/auth/o2/token',
    qs.stringify({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

  tokenCache = { token: resp.data.access_token, expiry: Date.now() + resp.data.expires_in * 1000 };
  return resp.data.access_token;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// List inbound shipments updated recently, filtered to RECEIVED/CLOSED
async function getReceivedShipments(sinceDays = 45) {
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
      params.ShipmentStatusList = ['RECEIVING', 'CLOSED'];
    }

    let resp;
    try {
      resp = await axios.get(`${SP_API_BASE}/fba/inbound/v0/shipments`, {
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

// For one shipment, get the per-SKU RECEIVED quantities
async function getShipmentReceivedItems(shipmentId) {
  const token = await getAccessToken();
  const items = [];
  let nextToken = null;

  do {
    const params = { MarketplaceId: MARKETPLACE_ID, QueryType: nextToken ? 'NEXT_TOKEN' : 'SHIPMENT' };
    if (nextToken) params.NextToken = nextToken;

    let resp;
    try {
      resp = await axios.get(`${SP_API_BASE}/fba/inbound/v0/shipments/${shipmentId}/items`, {
        headers: { 'x-amz-access-token': token },
        params,
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`[SP-API] items for ${shipmentId} failed:`, err.response?.status, body);
      return items;
    }

    const data = resp.data.payload?.ItemData || [];
    for (const it of data) {
      items.push({
        sku: it.SellerSKU,
        received: it.QuantityReceived || 0,
        shipped: it.QuantityShipped || 0,
      });
    }
    nextToken = resp.data.payload?.NextToken || null;
    await sleep(1200);
  } while (nextToken);

  return items;
}

// Get current FBA inventory (what Amazon holds) via FBA Inventory API
async function getFbaInventory() {
  const token = await getAccessToken();
  const results = {};
  let nextToken = null;
  do {
    const params = {
      granularityType: 'Marketplace',
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,
      details: true,
    };
    if (nextToken) params.nextToken = nextToken;
    let resp;
    try {
      resp = await axios.get(`${SP_API_BASE}/fba/inventory/v1/summaries`, {
        headers: { 'x-amz-access-token': token }, params,
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`FBA inventory ${err.response?.status}: ${body}`);
    }
    const sums = resp.data.payload?.inventorySummaries || [];
    for (const s of sums) {
      results[s.sellerSku] = {
        sku: s.sellerSku, asin: s.asin, fnSku: s.fnSku,
        total: s.totalQuantity || 0,
        fulfillable: s.inventoryDetails?.fulfillableQuantity || 0,
        inbound: (s.inventoryDetails?.inboundWorkingQuantity||0) + (s.inventoryDetails?.inboundShippedQuantity||0) + (s.inventoryDetails?.inboundReceivingQuantity||0),
      };
    }
    nextToken = resp.data.payload?.nextToken || null;
    await sleep(1000);
  } while (nextToken);
  return results;
}

// Sales velocity via the ALL ORDERS report (one report, not per-order calls = fast)
async function getSalesVelocity(days = 30) {
  const token = await getAccessToken();
  const zlib = require('zlib');
  const after = new Date(Date.now() - days*24*60*60*1000).toISOString();

  // 1. Request the flat-file all-orders report
  const createResp = await axios.post(`${SP_API_BASE}/reports/2021-06-30/reports`, {
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    marketplaceIds: [MARKETPLACE_ID],
    dataStartTime: after,
  }, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });

  const reportId = createResp.data.reportId;
  // 2. Poll for completion (up to ~90s)
  let docId = null;
  for (let i=0;i<18;i++){
    await sleep(5000);
    const st = await axios.get(`${SP_API_BASE}/reports/2021-06-30/reports/${reportId}`, { headers:{'x-amz-access-token':token} });
    const status = st.data.processingStatus;
    if (status==='DONE'){ docId = st.data.reportDocumentId; break; }
    if (status==='CANCELLED'||status==='FATAL') throw new Error('Report '+status);
  }
  if(!docId) throw new Error('Report timed out — try again in a moment');

  // 3. Download + parse
  const doc = await axios.get(`${SP_API_BASE}/reports/2021-06-30/documents/${docId}`, { headers:{'x-amz-access-token':token} });
  const dl = await axios.get(doc.data.url, { responseType:'arraybuffer' });
  let body = doc.data.compressionAlgorithm==='GZIP' ? zlib.gunzipSync(Buffer.from(dl.data)).toString('utf-8') : Buffer.from(dl.data).toString('utf-8');

  const lines = body.split(/\r?\n/).filter(l=>l);
  if(!lines.length) return {};
  const headers = lines[0].split('\t');
  const skuIdx = headers.indexOf('sku');
  const qtyIdx = headers.indexOf('quantity');
  const statusIdx = headers.indexOf('item-status');
  const skuUnits = {};
  for(let i=1;i<lines.length;i++){
    const c = lines[i].split('\t');
    const sku = c[skuIdx];
    const qty = parseInt(c[qtyIdx])||0;
    const st = (c[statusIdx]||'').toLowerCase();
    if(!sku || qty<=0 || st==='cancelled') continue;
    skuUnits[sku] = (skuUnits[sku]||0) + qty;
  }
  return skuUnits;
}

// Get Amazon prices per ASIN. Uses the getItemOffers endpoint per-ASIN which is
// more reliable for returning a current price than the batch price endpoint.
// Returns { asin: price }. Also returns diagnostics via a global.
async function getMyPrices(asins) {
  const token = await getAccessToken();
  const prices = {};
  const unique = [...new Set(asins.filter(Boolean))];
  let errors = 0, noPrice = 0, ok = 0;
  for (const asin of unique) {
    try {
      const resp = await axios.get(
        `${SP_API_BASE}/products/pricing/v0/items/${asin}/offers?MarketplaceId=${MARKETPLACE_ID}&ItemCondition=New`,
        { headers: { 'x-amz-access-token': token } });
      const payload = resp.data.payload || {};
      let amt = null;
      // 1. Buy Box price
      const bb = payload.Summary?.BuyBoxPrices?.[0];
      if (bb) amt = bb.ListingPrice?.Amount;
      // 2. Lowest price
      if (!amt) {
        const lp = payload.Summary?.LowestPrices?.[0];
        if (lp) amt = lp.ListingPrice?.Amount;
      }
      // 3. First offer
      if (!amt && payload.Offers?.length) {
        amt = payload.Offers[0].ListingPrice?.Amount;
      }
      if (amt) { prices[asin] = amt; ok++; } else { noPrice++; }
    } catch(e) {
      errors++;
      if (errors <= 3) console.error('[Pricing]', asin, e.response?.status, JSON.stringify(e.response?.data||e.message).slice(0,200));
    }
    await sleep(600); // ~1.6/sec, under the typical 2/sec limit
  }
  console.log(`[Pricing] Done: ${ok} priced, ${noPrice} no-price, ${errors} errors of ${unique.length}`);
  return prices;
}

module.exports = { getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity, getMyPrices };

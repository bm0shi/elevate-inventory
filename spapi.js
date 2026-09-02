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

// Sales velocity — units sold per SKU over last N days, via Orders API
async function getSalesVelocity(days = 30) {
  const token = await getAccessToken();
  const after = new Date(Date.now() - days*24*60*60*1000).toISOString();
  const skuUnits = {};
  let nextToken = null;
  let pages = 0;
  do {
    const params = nextToken
      ? { NextToken: nextToken }
      : { MarketplaceIds: MARKETPLACE_ID, CreatedAfter: after };
    let resp;
    try {
      resp = await axios.get(`${SP_API_BASE}/orders/v0/orders`, {
        headers: { 'x-amz-access-token': token }, params,
      });
    } catch (err) {
      const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Orders ${err.response?.status}: ${body}`);
    }
    const orders = resp.data.payload?.Orders || [];
    for (const o of orders) {
      // fetch items for each order
      try {
        await sleep(700);
        const ir = await axios.get(`${SP_API_BASE}/orders/v0/orders/${o.AmazonOrderId}/orderItems`, {
          headers: { 'x-amz-access-token': token },
        });
        const items = ir.data.payload?.OrderItems || [];
        for (const it of items) {
          const sku = it.SellerSKU;
          skuUnits[sku] = (skuUnits[sku]||0) + (it.QuantityOrdered||0);
        }
      } catch(e) { /* skip */ }
    }
    nextToken = resp.data.payload?.NextToken || null;
    pages++;
    await sleep(1500);
  } while (nextToken && pages < 20);
  return skuUnits;
}

module.exports = { getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity };

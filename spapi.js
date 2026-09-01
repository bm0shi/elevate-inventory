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

  const results = [];
  let nextToken = null;
  // statuses that mean Amazon has checked units in
  const statuses = ['RECEIVING', 'CLOSED'];

  do {
    const params = {
      MarketplaceId: MARKETPLACE_ID,
      QueryType: nextToken ? 'NEXT_TOKEN' : 'DATE_RANGE',
    };
    if (nextToken) {
      params.NextToken = nextToken;
    } else {
      params.LastUpdatedAfter = after;
      params.ShipmentStatusList = statuses.join(',');
    }

    let resp;
    try {
      resp = await axios.get(`${SP_API_BASE}/fba/inbound/v0/shipments`, {
        headers: { 'x-amz-access-token': token },
        params,
      });
    } catch (err) {
      console.error('[SP-API] shipments list failed:', err.response?.status, JSON.stringify(err.response?.data || err.message));
      throw err;
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
      console.error(`[SP-API] items for ${shipmentId} failed:`, err.response?.status, JSON.stringify(err.response?.data || err.message));
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

module.exports = { getReceivedShipments, getShipmentReceivedItems };

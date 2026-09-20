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
        const resp = await axios.get(
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
      const resp = await axios.get(url, { headers: { 'x-amz-access-token': token } });
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
      const resp = await axios.get(
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

      out[asin] = {
        amazonSelling: !!amazonOffer,                       // LIVE: Amazon has an offer
        amazonHasBuyBox: bbSeller === AMAZON_SELLER_ID,
        buyBoxExists: !!bbOffer,
        buyBoxPrice: bbOffer?.ListingPrice?.Amount ?? null,
        buyBoxIsFba: bbOffer?.IsFulfilledByAmazon ?? null,
        totalOffers: summary.TotalOfferCount ?? offers.length,
        lowestPrice: summary.LowestPrices?.[0]?.ListingPrice?.Amount ?? null,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      const st = err.response?.status;
      if (st === 429) { await sleep(4000); asins.push(asin); continue; }  // retry later
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
      const resp = await axios.get(url, { headers: { 'x-amz-access-token': token } });

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
      if (st === 429) { await sleep(3000); unique.push(asin); continue; }  // retry later
      out[asin] = { asin, error: e.response?.data?.errors?.[0]?.message || e.message };
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
      const r = await axios.get(url, { headers: { 'x-amz-access-token': token } });
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
      if (e.response?.status === 429) { await sleep(3000); unique.push(asin); continue; }
    }
    await sleep(600);

    // --- 2. inbound eligibility, when the listing declared nothing ---
    if (hazmat === null) {
      try {
        const url = `${SP_API_BASE}/fba/inbound/v1/eligibility/itemPreview?marketplaceIds=${MARKETPLACE_ID}&program=INBOUND&asinList=${asin}`;
        const r = await axios.get(url, { headers: { 'x-amz-access-token': token } });
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
const SETTLEMENT_TYPES = [
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
  'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE'
];

// Returns { reports, attempts } — attempts records what each variation actually
// did, so an empty result can be diagnosed instead of guessed at.
async function listSettlementReports(sinceDays = 180) {
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
    const variants = [
      { label: 'no date filter',   params: { reportTypes: rt, pageSize: 100 } },
      { label: 'DONE only',        params: { reportTypes: rt, processingStatuses: 'DONE', pageSize: 100 } },
      { label: 'date filtered',    params: { reportTypes: rt, processingStatuses: 'DONE', dataStartTime: after, pageSize: 100 } }
    ];

    for (const v of variants) {
      let nextToken = null, pages = 0, seen = 0, err = null;
      do {
        let resp;
        try {
          resp = await axios.get(`${SP_API_BASE}/reports/2021-06-30/reports`, {
            headers: { 'x-amz-access-token': token },
            params: nextToken ? { nextToken } : v.params,
            paramsSerializer: serialize
          });
        } catch (e) {
          const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 220) : String(e.message);
          err = `HTTP ${e.response?.status || '?'} ${body}`;
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
      if (found.length) break;
    }
    if (found.length) break;
  }
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
      const doc = await axios.get(`${SP_API_BASE}/reports/2021-06-30/documents/${documentId}`,
        { headers: { 'x-amz-access-token': token } });
      const dl = await axios.get(doc.data.url, { responseType: 'arraybuffer' });
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

module.exports = { listSettlementReports, downloadReportDocument, getHazmatStatus, getReceivedShipments, getShipmentReceivedItems, getFbaInventory, getSalesVelocity, getMyPrices, getCatalogImages, getCatalogItems, getLiveOffers };

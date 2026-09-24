// Amazon settlement flat-file parsing and the rules that classify settlement lines. Pure.
// Moved out of server.js unchanged so it can be tested on its own
// (test/settlement-parse.test.js).

// ============================================================
// SETTLEMENT REPORTS — real fees, real refunds
// Amazon's flat-file settlement is tab separated. Every row is one money
// movement, classified by amount-type / amount-description:
//   ItemPrice  + Principal                  -> gross revenue
//   ItemFees   + Commission                 -> referral fee
//   ItemFees   + FBAPerUnitFulfillmentFee   -> FBA pick & pack
//   ItemPrice  + Principal (Refund)         -> money returned to the customer
//   ItemFees   + RefundCommission           -> the bit Amazon keeps on a refund
// Fees are reported as NEGATIVE numbers; they are stored exactly as reported.
// ============================================================
function parseSettlementFlatFile(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return { header: null, rows: [] };

  // Header names differ between variants and marketplaces: 'amount-type',
  // 'Amount Type', 'amount_type'. Normalise both sides to letters+digits.
  const rawCols = lines[0].split('\t').map(c => c.trim());
  const cols = rawCols.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const at = (name) => cols.indexOf(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));

  const iSet = at('settlement-id'), iStart = at('settlement-start-date'), iEnd = at('settlement-end-date');
  const iDep = at('deposit-date'), iTotal = at('total-amount');
  const iTxn = at('transaction-type'), iOrder = at('order-id'), iSku = at('sku');
  const iShip = at('shipment-id');
  const iQty = at('quantity-purchased'), iPosted = at('posted-date');
  const iItem = at('order-item-code');

  // TALL layout (V2): one amount per row.
  const iType = at('amount-type'), iDesc = at('amount-description'), iAmt = at('amount');
  // WIDE layout (V1): several typed amounts per row, each its own column pair.
  const PAIRS = [
    { type: at('price-type'),            amt: at('price-amount'),            kind: 'ItemPrice' },
    { type: at('item-related-fee-type'), amt: at('item-related-fee-amount'), kind: 'ItemFees'  },
    { type: at('shipment-fee-type'),     amt: at('shipment-fee-amount'),     kind: 'ItemFees'  },
    { type: at('order-fee-type'),        amt: at('order-fee-amount'),        kind: 'ItemFees'  },
    { type: at('promotion-type'),        amt: at('promotion-amount'),        kind: 'Promotion' },
    { type: at('direct-payment-type'),   amt: at('direct-payment-amount'),   kind: 'other-transaction' },
  ];
  // Amounts with no type column of their own.
  const iMisc = at('misc-fee-amount');
  const iOtherFee = at('other-fee-amount'), iOtherReason = at('other-fee-reason-description');
  const iOtherAmt = at('other-amount');

  const isWide = PAIRS.some(p2 => p2.type >= 0 && p2.amt >= 0) || iOtherFee >= 0;
  const isTall = iType >= 0 && iAmt >= 0;

  console.log('[Settlement] columns:', JSON.stringify(rawCols));
  console.log(`[Settlement] layout detected: ${isWide ? 'WIDE (flat file v1)' : (isTall ? 'TALL (v2)' : 'UNKNOWN')}`);
  if (!isWide && !isTall) console.error('[Settlement] neither layout recognised — no amount columns found.');

  const num = (v) => { const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const date = (v) => {
    const t = String(v || '').trim();
    if (!t) return null;
    const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);         // 2026-08-29T13:34:05+00:00
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const m = t.match(/^(\d{1,2})[-\/.]([A-Za-z]{3}|\d{1,2})[-\/.](\d{4})/);
    if (m) {
      const MON = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      let day = +m[1], mo = isNaN(+m[2]) ? MON[m[2].toLowerCase()] : (+m[2] - 1);
      // Day-first (29.08.2026) is the default, but a US date (08/29/2026)
      // read that way gave month 29 — an invalid date that failed the whole
      // settlement's insert. If the "month" can't be one, it's month-first.
      if (!isNaN(+m[2]) && mo > 11 && +m[1] <= 12) { mo = +m[1] - 1; day = +m[2]; }
      if (mo != null && mo <= 11) return `${m[3]}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };

  let header = null;
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split('\t');
    const settlementId = (f[iSet] || '').trim();
    if (!settlementId) continue;

    // The first row carries the settlement totals and no transaction detail.
    if (!header && iTotal >= 0 && f[iTotal] && String(f[iTotal]).trim()) {
      header = {
        settlement_id: settlementId,
        start_date: date(f[iStart]), end_date: date(f[iEnd]),
        deposit_date: date(f[iDep]), total_amount: num(f[iTotal])
      };
    }

    const base = {
      settlement_id: settlementId,
      posted_date: date(f[iPosted]) || (header && header.end_date) || null,
      transaction_type: (f[iTxn] || '').trim() || null,
      order_id: (f[iOrder] || '').trim() || null,
      shipment_id: iShip >= 0 ? ((f[iShip] || '').trim() || null) : null,
      sku: (f[iSku] || '').trim() || null,
      item_code: iItem >= 0 ? ((f[iItem] || '').trim() || null) : null,
      quantity: iQty >= 0 ? (parseInt(f[iQty], 10) || 0) : 0,
      deposit_date: header ? header.deposit_date : null
    };

    if (isTall) {
      const amt = num(f[iAmt]);
      if (amt == null) continue;
      rows.push({ ...base, row_idx: rows.length,
        amount_type: (f[iType] || '').trim() || null,
        amount_description: (f[iDesc] || '').trim() || null,
        amount: amt });
      continue;
    }

    // WIDE: emit one row per populated (type, amount) pair on this line.
    let emitted = 0;
    for (const pr of PAIRS) {
      if (pr.amt < 0) continue;
      const amt = num(f[pr.amt]);
      if (amt == null || amt === 0) continue;
      const desc = (pr.type >= 0 ? (f[pr.type] || '').trim() : '') || pr.kind;
      rows.push({ ...base, row_idx: rows.length, amount_type: pr.kind, amount_description: desc, amount: amt });
      emitted++;
      // quantity belongs to the sale line only, never to a fee
      if (pr.kind !== 'ItemPrice') rows[rows.length - 1].quantity = 0;
    }
    if (iMisc >= 0) {
      const a = num(f[iMisc]);
      if (a != null && a !== 0) { rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'ItemFees', amount_description: 'MiscFee', amount: a }); emitted++; }
    }
    if (iOtherFee >= 0) {
      const a = num(f[iOtherFee]);
      if (a != null && a !== 0) {
        const reason = (iOtherReason >= 0 ? (f[iOtherReason] || '').trim() : '') || 'OtherFee';
        // Inbound transport / placement fees arrive here.
        rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'other-transaction', amount_description: reason, amount: a });
        emitted++;
      }
    }
    if (iOtherAmt >= 0) {
      const a = num(f[iOtherAmt]);
      if (a != null && a !== 0) {
        rows.push({ ...base, row_idx: rows.length, quantity: 0, amount_type: 'other-transaction',
                    amount_description: base.transaction_type || 'Other', amount: a });
        emitted++;
      }
    }
  }

  // Quantity does not always sit on the same row as the Principal amount — it
  // can be on another row of the same order item, or on a row with no amount
  // at all (which is never emitted). Collect it per order item from every
  // source line, then put it on that item's Principal row and nowhere else.
  if (isWide) {
    const qtyByItem = {};
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split('\t');
      const q = iQty >= 0 ? (parseInt(f[iQty], 10) || 0) : 0;
      if (!q) continue;
      const key = ((f[iOrder] || '').trim()) + '|' + (iItem >= 0 ? (f[iItem] || '').trim() : ((f[iSku] || '').trim()));
      if (Math.abs(q) > Math.abs(qtyByItem[key] || 0)) qtyByItem[key] = q;
    }
    let fromItem = 0, estimated = 0;
    const seen = new Set();
    for (const r of rows) {
      const isPrin = r.amount_type === 'ItemPrice' && /principal/i.test(r.amount_description || '');
      if (!isPrin) { r.quantity = 0; continue; }
      const key = (r.order_id || '') + '|' + (r.item_code || r.sku || '');
      if (seen.has(key)) { r.quantity = 0; continue; }   // one unit count per item
      seen.add(key);
      const q = qtyByItem[key];
      if (q) { r.quantity = Math.abs(q) * Math.sign(r.amount || 1); fromItem++; }
      else if (r.amount) { r.quantity = Math.sign(r.amount); estimated++; }
    }
    console.log(`[Settlement] units: ${fromItem} item(s) from quantity-purchased, ${estimated} assumed 1 (no quantity found).`);
  }

  if (!header) header = { settlement_id: rows.length ? rows[0].settlement_id : null,
                          start_date: null, end_date: null, deposit_date: null, total_amount: null };
  return { header, rows };
}

// Real, per-ASIN economics over a date range, straight from the settlements.
// Sales tax Amazon collects as marketplace facilitator passes THROUGH the
// settlement: in as a price-type of Tax/ShippingTax, out as a
// MarketplaceFacilitatorTax fee. It is not revenue and not an Amazon fee —
// counting it on both sides inflates Net Sales and Fees equally.
function isPassThroughTax(amountType, desc) {
  const d = String(desc || '');
  if (amountType === 'ItemPrice') return /tax/i.test(d);
  if (amountType === 'ItemFees' || amountType === 'other-transaction') return /MarketplaceFacilitator|TaxWithheld|Tax-?Withholding/i.test(d);
  return false;
}

// ---- Inbound shipment costs ----
// Fee kinds Amazon uses for inbound charges, so settlement rows can be spotted.
const INBOUND_FEE_PATTERNS = /inbound|placement|transportation|partnered.?carrier|convenience/i;

module.exports = { parseSettlementFlatFile, isPassThroughTax, INBOUND_FEE_PATTERNS };

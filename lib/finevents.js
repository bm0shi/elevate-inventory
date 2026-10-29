// Refunds and Amazon fees by day from the Finances API's financial events
// (listFinancialEvents). They post within hours, where settlements close only
// every two weeks, so the dashboard's Refunds are current (owner: refunds
// "need to be hard refreshed on time"). Pure: takes the API's event-list
// payloads, returns totals per Pacific day.
//
// Same split as the P&L: refunds = every refunded charge except tax (tax is
// pass-through); fees = item fees on shipments plus fee adjustments on
// refunds (the referral fee Amazon hands back, less its refund commission).
const { zoneParts } = require('./velocity');

const num = a => (a && a.CurrencyAmount != null) ? Number(a.CurrencyAmount) || 0 : 0;

function aggregateFinancialEvents(payloads, fromDay, toDay, tz = 'America/Los_Angeles') {
  const days = {};
  for (let d = new Date(fromDay + 'T12:00:00Z'); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const k = d.toISOString().slice(0, 10); if (k > toDay) break; days[k] = { refunds: 0, refundUnits: 0, fees: 0 };
  }
  const at = ts => { const t = Date.parse(ts); return isNaN(t) ? null : days[zoneParts(t, tz).day] || null; };
  for (const p of [].concat(payloads)) {
    const ev = (p && (p.FinancialEvents || p)) || {};
    for (const e of ev.ShipmentEventList || []) {
      const x = at(e.PostedDate); if (!x) continue;
      for (const it of e.ShipmentItemList || []) for (const f of it.ItemFeeList || []) x.fees += num(f.FeeAmount);
    }
    for (const e of ev.RefundEventList || []) {
      const x = at(e.PostedDate); if (!x) continue;
      for (const it of e.ShipmentItemAdjustmentList || []) {
        let principal = false;
        for (const c of it.ItemChargeAdjustmentList || []) {
          if (/tax/i.test(c.ChargeType || '')) continue;
          x.refunds += num(c.ChargeAmount);
          if (/principal/i.test(c.ChargeType || '')) principal = true;
        }
        for (const f of it.ItemFeeAdjustmentList || []) x.fees += num(f.FeeAmount);
        if (principal) x.refundUnits += Math.abs(Number(it.QuantityShipped) || 0);
      }
    }
  }
  for (const k in days) { days[k].refunds = Math.round(days[k].refunds * 100) / 100; days[k].fees = Math.round(days[k].fees * 100) / 100; }
  return days;
}

// The same events as settlement-style lines (amount_type / amount_description /
// transaction_type as the settlement flat file names them), so the P&L can
// fill the days and orders Amazon hasn't settled yet with the exact rules it
// uses for settlements (owner 10/29: P&L said $112k for October while the
// dashboard said $149k, because settlements stop at the last payout). Each
// line keeps its order id: once a settlement carries that order, the
// settlement's lines count and these drop out (finance.js aggregate).
// day = UTC date, as settlement posted_date is stored.
function eventLines(payloads) {
  const out = [];
  const day = ts => { const t = Date.parse(ts); return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
  const push = (e, kind, txn, sku, type, desc, amt, qty) => {
    const a = Math.round(num(amt) * 100) / 100; if (!a) return;
    const d = day(e.PostedDate || e.postedDate); if (!d) return;
    out.push({ day: d, posted: new Date(Date.parse(e.PostedDate || e.postedDate)).toISOString(), kind, transaction_type: txn,
      order_id: e.AmazonOrderId || null, sku: sku || null, amount_type: type, amount_description: desc, amount: a, quantity: qty || 0 });
  };
  // Shipments and refunds (and chargebacks / A-to-z claims, which carry the same lists)
  const items = (e, kind, txn, list, charges, fees, promos) => {
    for (const it of e[list] || []) {
      const sku = it.SellerSKU;
      const q = Math.abs(Number(it.QuantityShipped) || 0);
      for (const c of it[charges] || []) {
        const t = c.ChargeType || 'Other';
        // units on the Principal line only, like the settlement parser; negative on a refund
        push(e, kind, txn, sku, 'ItemPrice', t, c.ChargeAmount, /^principal$/i.test(t) ? (kind === 'refund' ? -q : q) : 0);
      }
      for (const f of it[fees] || []) push(e, kind, txn, sku, 'ItemFees', f.FeeType || 'Fee', f.FeeAmount, 0);
      for (const p of it[promos] || []) push(e, kind, txn, sku, 'Promotion', p.PromotionType || 'Promotion', p.PromotionAmount, 0);
      // marketplace facilitator tax Amazon keeps: pass-through, like the settlement's
      for (const w of it.ItemTaxWithheldList || []) for (const c of w.TaxesWithheld || [])
        push(e, kind, txn, sku, 'ItemFees', c.ChargeType || 'MarketplaceFacilitatorTax', c.ChargeAmount, 0);
    }
    for (const c of e.OrderChargeList || e.OrderChargeAdjustmentList || []) push(e, kind, txn, null, 'ItemPrice', c.ChargeType || 'Other', c.ChargeAmount, 0);
    for (const f of [].concat(e.ShipmentFeeList || e.ShipmentFeeAdjustmentList || [], e.OrderFeeList || e.OrderFeeAdjustmentList || []))
      push(e, kind, txn, null, 'ItemFees', f.FeeType || 'Fee', f.FeeAmount, 0);
  };
  for (const p of [].concat(payloads)) {
    const ev = (p && (p.FinancialEvents || p)) || {};
    for (const e of ev.ShipmentEventList || []) items(e, 'order', 'Order', 'ShipmentItemList', 'ItemChargeList', 'ItemFeeList', 'PromotionList');
    for (const [list, txn] of [['RefundEventList', 'Refund'], ['ChargebackEventList', 'Chargeback Refund'], ['GuaranteeClaimEventList', 'A-to-z Guarantee Refund']])
      for (const e of ev[list] || []) items(e, 'refund', txn, 'ShipmentItemAdjustmentList', 'ItemChargeAdjustmentList', 'ItemFeeAdjustmentList', 'PromotionAdjustmentList');
    // Not tied to an order: reimbursements and other adjustments, ads, coupons, deals, SAFE-T.
    // (Service fees such as storage carry no date in this API; they come with the settlement.)
    for (const e of ev.AdjustmentEventList || []) {
      const t = String(e.AdjustmentType || 'Adjustment');
      // 'WAREHOUSE_DAMAGE' → words, so the P&L's reimbursement test reads it
      const desc = (/reimburs|damage|lost|compensat/i.test(t) ? 'FBA Inventory Reimbursement - ' : '') + t.replace(/_/g, ' ');
      push({ ...e, AmazonOrderId: null }, 'other', 'other-transaction', null, 'other-transaction', desc, e.AdjustmentAmount, 0);
    }
    for (const e of ev.ProductAdsPaymentEventList || []) {
      const v = Math.abs(num(e.transactionValue));
      push({ PostedDate: e.postedDate }, 'other', 'other-transaction', null, 'other-transaction', 'Cost of Advertising',
        { CurrencyAmount: /refund/i.test(e.transactionType || '') ? v : -v }, 0);
    }
    for (const e of ev.CouponPaymentEventList || []) push({ PostedDate: e.PostedDate }, 'other', 'other-transaction', null, 'other-transaction', 'Coupon fee', e.TotalAmount, 0);
    for (const e of ev.SellerDealPaymentEventList || []) push({ PostedDate: e.postedDate }, 'other', 'other-transaction', null, 'other-transaction', 'Deal fee', e.totalAmount, 0);
    for (const e of ev.SAFETReimbursementEventList || []) push({ PostedDate: e.PostedDate }, 'other', 'other-transaction', null, 'other-transaction', 'SAFE-T reimbursement', e.ReimbursedAmount, 0);
  }
  return out;
}

module.exports = { aggregateFinancialEvents, eventLines };

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

module.exports = { aggregateFinancialEvents };

const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/reprice');

// Arizona clock time on 2026-10-12 → epoch ms (Arizona is UTC-7, no DST).
const az = (h, m, day = 12) => Date.UTC(2026, 9, day, h + 7, m);
const SLOT = { id: 's1', drop: '00:45', back: '03:45', on: true };

test('settings: arrive off with the old bot\'s window; bad input is refused with a plain reason', () => {
  const d = R.checkSettings({});
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.settings.enabled, false);
  assert.deepStrictEqual(d.settings.slots, [SLOT]);
  assert.match(R.checkSettings({ drop: 0 }).error, /between \$0.01/);
  assert.match(R.checkSettings({ slots: [{ drop: '01:00', back: '01:10' }] }).error, /10 minutes long/);
  assert.match(R.checkSettings({ slots: [{ drop: '01:00', back: '14:00' }] }).error, /12 hours is the most/);
  assert.match(R.checkSettings({ slots: [{ drop: '1am', back: '02:00' }] }).error, /pick both times/);
  assert.strictEqual(R.checkSettings({ drop: '0.999', enabled: true }).settings.drop, 1);
  assert.strictEqual(R.checkSettings({ enabled: 'yes' }).settings.enabled, false);   // only a real true turns it on
});

test('slots: overlaps refused (also across midnight); a switched-off slot may overlap; ids kept and new ones numbered', () => {
  assert.match(R.checkSettings({ slots: [SLOT, { drop: '03:00', back: '05:00' }] }).error, /overlap/);
  assert.match(R.checkSettings({ slots: [{ drop: '23:00', back: '01:00' }, { drop: '00:30', back: '02:00' }] }).error, /overlap/);
  assert.strictEqual(R.checkSettings({ slots: [SLOT, { drop: '03:45', back: '05:00' }] }).ok, true);   // back-to-back is fine
  const r = R.checkSettings({ slots: [SLOT, { drop: '02:00', back: '04:00', on: false }, { drop: '13:00', back: '14:00' }] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.settings.slots.map(s => s.id), ['s1', 's2', 's3']);
  const k = R.checkSettings({ slots: [{ id: 's2', drop: '13:00', back: '14:00' }, { drop: '1:00', back: '2:00' }] }).settings.slots;
  assert.deepStrictEqual(k.map(s => [s.id, s.drop]), [['s2', '13:00'], ['s1', '01:00']]);
});

test('windows: inside 12:45–3:45 AM, stop at the end, a slot crossing midnight files under the night it started', () => {
  assert.strictEqual(R.activeRun([SLOT], az(0, 44)), null);
  const r = R.activeRun([SLOT], az(0, 45));
  assert.strictEqual(r.cycle, '2026-10-12/s1');
  assert.strictEqual(r.end, az(3, 45));
  assert.strictEqual(R.activeRun([SLOT], az(3, 45)), null);
  assert.strictEqual(R.activeRun([{ ...SLOT, on: false }], az(1, 0)), null);
  const late = { id: 'n', drop: '23:30', back: '02:00', on: true };
  assert.strictEqual(R.activeRun([late], az(1, 0, 13)).cycle, '2026-10-12/n');
  assert.strictEqual(R.activeRun([late], az(23, 45)).cycle, '2026-10-12/n');
  assert.strictEqual(R.nextRun([SLOT, late], az(12, 0)).start, az(23, 30));
  assert.strictEqual(R.nextRun([SLOT], az(4, 0)).start, az(0, 45, 13));
});

test('drop price: flat amount off, refused at or below zero or past the % cap', () => {
  assert.deepStrictEqual(R.dropPrice(24.99, 1, 35), { price: 23.99 });
  assert.match(R.dropPrice(2.5, 1, 35).blocked, /40.0% off/);
  assert.match(R.dropPrice(1, 1, 200).blocked, /reach \$0.00/);
  assert.match(R.dropPrice(null, 1, 35).blocked, /no live price/);
});

test('restore: fresh drops always go back; old ones only if still at the drop price', () => {
  const now = az(4, 0);
  const row = { original_price: 24.99, drop_price: 23.99, dropped_at: new Date(az(1, 0)).toISOString() };
  assert.strictEqual(R.restoreAction(row, 30, now).act, 'restore');   // fresh: live price not trusted
  const old = { ...row, dropped_at: new Date(az(1, 0, 10)).toISOString() };
  assert.strictEqual(R.restoreAction(old, 23.99, now).act, 'restore');
  assert.strictEqual(R.restoreAction(old, 24.99, now).act, 'cleared');
  assert.strictEqual(R.restoreAction(old, 27.5, now).act, 'left_alone');
  assert.strictEqual(R.restoreAction(old, null, now).act, 'left_alone');
});

test('sku keys ignore leading zeros a spreadsheet dropped', () => {
  assert.strictEqual(R.skuKey('000123'), R.skuKey('123'));
  assert.strictEqual(R.skuKey('AB-01'), 'AB-01');
});

test('per-product drops: their own amount, everything else the main drop; bad ones refused', () => {
  const r = R.checkSettings({ drop: 1, overrides: [{ asin: 'b00k34nh4o', drop: '2.5' }, { asin: 'B001A3W8QA', drop: 0.5 }, { asin: 'B001A3W8QA', drop: 0.75 }] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.settings.overrides, [{ asin: 'B00K34NH4O', drop: 2.5 }, { asin: 'B001A3W8QA', drop: 0.75 }]);
  assert.strictEqual(R.dropFor('B00K34NH4O', r.settings), 2.5);
  assert.strictEqual(R.dropFor('B001A3W8QA', r.settings), 0.75);
  assert.strictEqual(R.dropFor('B01DCBH560', r.settings), 1);
  assert.strictEqual(R.dropFor('B01DCBH560', R.checkSettings({ drop: 1.5, overrides: r.settings.overrides }).settings), 1.5);   // main drop changed, the rest follow
  assert.match(R.checkSettings({ overrides: [{ asin: 'tea tree', drop: 1 }] }).error, /not an ASIN/);
  assert.match(R.checkSettings({ overrides: [{ asin: 'B00K34NH4O', drop: 0 }] }).error, /between \$0.01/);
  assert.deepStrictEqual(R.checkSettings({}).settings.overrides, []);
});

const test = require('node:test');
const assert = require('node:assert');
const f = require('../lib/freight-est');

test('freight estimate: farther and heavier costs more; unknown places give nothing', () => {
  const from = { city: 'Glendale', state: 'AZ' };
  const near = f.estimate([{ weight: 900 }], from, { city: 'Moreno Valley', state: 'CA' }, 1);
  const far = f.estimate([{ weight: 900 }], from, { city: 'Hagerstown', state: 'MD' }, 1);
  assert.ok(near.miles > 250 && near.miles < 450, 'Glendale → Moreno Valley is ~350 road miles');
  assert.ok(far.miles > 2000 && far.miles < 2700);
  assert.ok(far.cost > near.cost * 2);
  assert.ok(f.estimate([{ weight: 1400 }], from, { city: 'Hagerstown', state: 'MD' }, 1).cost > far.cost);
  assert.strictEqual(f.estimate([{ weight: 900 }], from, { city: 'Nowhere', state: 'ZZ' }, 1), null);
  // A town not in the list falls back to its state's middle.
  assert.strictEqual(f.estimate([{ weight: 900 }], from, { city: 'Smallville', state: 'KS' }, 1).exact, false);
});

test('freight estimate: our real bills correct the rate (median, held to 0.5–2)', () => {
  const pal = [{ weight: 1000 }];
  const m = f.modelCost(pal, 400);
  assert.deepStrictEqual(f.calibrate([]), { k: 1, n: 0 });
  assert.strictEqual(f.calibrate([{ actual: m * 1.2, pallets: pal, miles: 400 }, { actual: m * 1.4, pallets: pal, miles: 400 }, { actual: m * 5, pallets: pal, miles: 400 }]).k.toFixed(2), '1.40');
  assert.strictEqual(f.calibrate([{ actual: m * 9, pallets: pal, miles: 400 }]).k, 2);
});

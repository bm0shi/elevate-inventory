const test = require('node:test');
const assert = require('node:assert');
const { myPricesFromPayload, chunk } = require('../lib/prices');

test('our listing price per ASIN from getPricing: first offer with a price; failed or empty entries left out (owner 11/8)', () => {
  const payload = [
    { status: 'Success', ASIN: 'B0000000A1', Product: { Offers: [{ BuyingPrice: { ListingPrice: { Amount: 24.99, CurrencyCode: 'USD' } } }] } },
    { status: 'Success', ASIN: 'B0000000A2', Product: { Offers: [{ BuyingPrice: { LandedPrice: { Amount: '31.50' } } }] } },
    { status: 'Success', ASIN: 'B0000000A3', Product: { Offers: [] } },
    { status: 'ClientError', ASIN: 'B0000000A4', Product: { Offers: [{ BuyingPrice: { ListingPrice: { Amount: 9 } } }] } },
    { status: 'Success', Product: { Identifiers: { MarketplaceASIN: { ASIN: 'B0000000A5' } }, Offers: [{ BuyingPrice: { ListingPrice: { Amount: 0 } } }, { BuyingPrice: { ListingPrice: { Amount: 12 } } }] } },
  ];
  assert.deepStrictEqual(myPricesFromPayload(payload), { B0000000A1: 24.99, B0000000A2: 31.5, B0000000A5: 12 });
  assert.deepStrictEqual(myPricesFromPayload(null), {});
});

test('chunks of 20', () => {
  const c = chunk(Array.from({ length: 45 }, (_, i) => i), 20);
  assert.deepStrictEqual(c.map(x => x.length), [20, 20, 5]);
  assert.deepStrictEqual(chunk([], 20), []);
});

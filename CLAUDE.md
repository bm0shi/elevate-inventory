# Elevate Inventory

Warehouse inventory and finance app for an Amazon FBA seller. Product is bought
from Cosmoprof, received and scanned in the warehouse, prepped (FNSKU labels,
bundles), and shipped to FBA. The owner side adds cost tracking, Amazon
settlements, and a P&L.

Node + Express 4 + Postgres (`pg`). No build step, no framework on the front
end. Unit tests for the pure helpers (`npm test`). Deployed on Railway (deploys
from the GitHub repo).

## Files

| File | What it is |
| --- | --- |
| `server.js` | The whole backend: schema/migrations (`initDb`), auth, ~118 `/api/*` routes, invoice parsing, receiving, prep, settlements, P&L, market data. Mounts `finance.js` and `autorun.js` at the bottom. |
| `finance.js` | Owner finance screens (`/api/finance/*`): P&L, product profit, cash & draws, overhead, supplies, royalty, data sources. Owns the `fin_*` tables. Exported as `module.exports = (app, deps) => {...}`. |
| `autorun.js` | Weekly auto-refresh (`/api/auto/*`), Sundays 11:59 PM Arizona (always UTC-7, no DST). Calls the app's own endpoints in order, then snapshots the P&L. Catches up within six days if the server was down. |
| `spapi.js` | Amazon Selling Partner API client: LWA tokens, reports, settlements, FBA inventory, sales velocity, prices, catalog, inbound shipments/fees, hazmat. |
| `keepa.js` | Keepa API client (market data, tracked ASINs). |
| `index.html` | The entire front end: one large file with inline CSS/JS, served at `/`. |
| `lib/*.js` | Pure helpers moved out of `server.js` so they can be tested: `smartscout` (SmartScout CSV exports uploaded in Admin → Smart Scout, and the pie: listing units minus Amazon's Buy Box share, split between third-party FBA sellers), `demand` (our share of a listing's sales from the Buy Box split, used by Send Next and Suggested Orders), `invoice-parse` (Cosmoprof/Xstore parsing, `findInvoiceDate`), `settlement-parse` (settlement flat files, `isPassThroughTax`, `INBOUND_FEE_PATTERNS`), `homebase` (timesheet CSV), `costs` (`blendCosts`), `matching` (invoice-line → product suggestions), `codes` (`normCode`, rack layout and locations, `badQty`), `locations` (suggested pallet spots keeping duo partners side by side), `restock` (Amazon's restock report, shown beside our Send), `capacity` (FBA capacity in cubic feet from package sizes; the limit itself isn't in the API, so the owner enters it from Seller Central's Capacity Monitor), `forecast` (the one demand number used by Send Next, Rec. Order, Pending Prep and On Hand: blends our sales corrected for days out of stock (from the `inv_fba_daily` snapshots), raw sales, SmartScout, Keepa and the even split of the pie, and learns the weights from a daily log scored 30 days later). Also `weekly-email` (Sunday summary email). No database access in the parsers. |
| `test/*.test.js` | `node:test` unit tests for `lib/`. Run with `npm test`. |
| `*.json` | Seed/reference data read at startup or by specific routes: `products.json` (catalog seed), `cosmo_map.json` (Cosmoprof item # → ASIN), `seed_costs.json`, `seed_fnskus.json`, `keepa_asins.json`, `smartscout_products.json` (products-to-add research). |

`server.js` and `index.html` are very large. Find things with grep (route
paths, function names, table names) and read the section you need rather than
the whole file.

## Running

```
npm install
DATABASE_URL=postgres://... npm start   # PORT defaults to 3000
```

`initDb()` creates every `inv_*` table and applies migrations idempotently on
each boot (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), then seeds
from the JSON files. There is no migrations folder. Add new schema the same way
inside `initDb()` (or the `fin_*` setup in `finance.js`). If the DB init fails,
the server still starts so the error is visible.

Bump `BUILD_ID` in `server.js` when shipping a change. It's logged at startup
and shown in the UI so you can confirm the deploy is live.

### Environment variables

- `DATABASE_URL`: Postgres. SSL is enabled automatically when the URL contains `railway`.
- `APP_PASSWORD`: warehouse staff login.
- `OWNER_PASSWORD`: owner login.
- `AUTH_DISABLED`: turns off the warehouse gate only.
- `AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_REFRESH_TOKEN`, `AMAZON_MARKETPLACE_ID`: SP-API. The `*_FM` variants take precedence when set.
- `KEEPA_API_KEY`
- `RECONCILE_LOOKBACK_DAYS`

## Auth model (important)

- `auth` middleware: warehouse routes. Checks the `x-app-password` header and honors `AUTH_DISABLED`.
- `ownerAuth` middleware: checks the `x-owner-password` header. It does **not** honor `AUTH_DISABLED` and does **not** accept the app password. Staff must never see velocity, margin, cost, inventory value, settlements, or the P&L.
- Any new route that exposes money, cost, velocity, or value data must use `ownerAuth`. Hiding a screen in `index.html` is not protection.
- Owner-approved exceptions (for now, three trusted staff): `/api/ss-avg` (other sellers' average sales) and `/api/demand` (the best-estimate monthly sales per listing, for days covered on Pending Prep and On Hand) use `auth`. Revisit when per-person PINs or a separate staff link are added.
- Passwords are compared with `safeEq` (timing-safe), and login routes are rate limited (`loginLimiter`).

## Domain rules learned the hard way

These live in comments next to the code. Read the comment before changing the code.

- **Cosmoprof invoices repeat `FOR ORDER NUMBER:` on every page.** Merge all segments with the same order number *before* writing. Writes start with `DELETE ... WHERE order_number`, so writing page by page used to wipe earlier pages.
- **Invoice dates come in several formats** (`9/18/26`, `Sep 18, 2026`). `findInvoiceDate` normalizes them to M/D/YY.
- **Cosmo-map entries are only trusted after a physical barcode scan confirms them** (`inv_cosmo_map.verified`). Seeded or hand-picked mappings start unverified.
- **Name-match suggestions never show a percentage.** Only a single, clearly winning match is offered, because workers treat a number as certainty.
- **Hazmat:** a manual call by the owner always outranks Amazon's declaration (`hazmat_source`).
- **Pass-through tax** and **inbound fee patterns** (`isPassThroughTax`, `INBOUND_FEE_PATTERNS`) decide how settlement lines land in the P&L. They're shared with `finance.js`.
- The autorun can't pull Cosmoprof invoices, Homebase timesheets, or bank balances. Those stay manual.

## Conventions

- Plain CommonJS, `async`/`await`, raw SQL through `pool.query` with `$n` parameters. Never interpolate user input into SQL.
- Tables are prefixed `inv_` (inventory/ops, in `server.js`) or `fin_` (finance, in `finance.js`).
- Long-running jobs (market data, inventory value, name refresh) use a `/start` + `/status` polling pattern. Results are cached in `inv_cache`.
- Comments explain *why*, often with the incident that caused the rule. Keep that style.
- Keep changes surgical. These files are large, and whole-file rewrites have broken things before.

### Rules for anything that moves stock or money

- **Errors:** every `app.get/post/...` handler is wrapped (see `wrapAsync`), so a thrown error becomes a 400/500 JSON reply instead of crashing the process. Don't add bare `process.exit` or unhandled timers.
- **Transactions:** a change that touches more than one row or table goes through `withTx(async (db) => { ... })`, using `db.query` inside. Lock the row that decides whether the action is allowed (`SELECT ... FOR UPDATE`) and check its state inside the transaction. Examples: invoice complete, `lockShipment`, prep complete.
- **Once only:** stock actions must be safe to send twice. Invoices can be completed once; a shipment's units are deducted once (`lockShipment`); marking a shipment received works only while it's `in_transit`.
- **Action ids:** the browser sends `x-idem-key` (from `newIdem()`) on stock-changing POSTs. The `idempotency` middleware replays the first reply for a repeated id. Reuse the same id when retrying the same action.
- **Quantities:** validate with `badQty(q)` (1..`MAX_QTY`). A barcode typed into a qty box is the usual cause of absurd quantities.
- **Prepped:** stored as scanned (single under its ASIN, duo under the duo ASIN). Use `consumePrepped` when shipping.
- **Front end:** wrap any outside text (names, descriptions, error messages) in `esc()` before putting it into HTML. Check `d.ok === false` / `d.error` on every stock action and show the failure; never toast success without checking.
- **Amazon:** go through the `http` client in `spapi.js` (fresh token per request, timeout). Don't swallow errors into empty results — callers treat empty as "nothing there".

## Checking a change

```
npm test                                   # unit tests for lib/ (no database needed)
node --check server.js finance.js autorun.js spapi.js keepa.js
```

When you change a parser or rule in `lib/`, add a test for the case that
prompted it. Routes in `server.js` have no automated tests: check them against
a local Postgres (`DATABASE_URL=... npm start`) and in the browser.

## Workflow with the owner

- The owner has approved merging PRs without asking: once a change the owner asked for (or agreed to) is built and tested, merge its PR into `main` and say it's live. Railway deploys `main`.
- Still ask first for anything the owner hasn't agreed to, and flag clearly when a change affects stock counts, money or logins.
- After merging, start the next change from the latest `main`.

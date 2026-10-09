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
| `spapi.js` | Amazon Selling Partner API client: LWA tokens, reports, settlements, FBA inventory, sales velocity, prices, catalog, inbound shipments/fees, hazmat, and `findInboundShipment` (one shipment's destination address and items, for 2D Production). |
| `keepa.js` | Keepa API client (market data, tracked ASINs). |
| `index.html` | The entire front end: one large file with inline CSS/JS, served at `/`. |
| `dash2.js` | The Admin dashboard (the "new look", default since the owner made it permanent). The classic dashboard in `index.html` is the backup: the sidebar's "Classic view" switches a device to it (localStorage `dashView='classic'`), and "Back to the new look" switches back; if dash2.js fails to load, Classic shows for that visit. Served at `/dash2.js`, loaded only when switched on; its history series come from `/api/dash2` (owner). Its gross sales come from `inv_sales_daily` (`/api/sales/history`). |
| `lib/*.js` | Pure helpers moved out of `server.js` so they can be tested: `smartscout` (SmartScout CSV exports uploaded in Admin → Smart Scout, and the pie: listing units minus Amazon's Buy Box share, split between third-party FBA sellers), `demand` (our share of a listing's sales from the Buy Box split, used by Send Next and Suggested Orders), `invoice-parse` (Cosmoprof/Xstore parsing, `findInvoiceDate`), `settlement-parse` (settlement flat files, `isPassThroughTax`, `INBOUND_FEE_PATTERNS`), `homebase` (timesheet CSV), `costs` (`blendCosts`), `matching` (invoice-line → product suggestions), `codes` (`normCode`, rack layout and locations, `badQty`), `locations` (suggested pallet spots keeping duo partners side by side), `restock` (Amazon's restock report, shown beside our Send), `pack` (the 2D Production tab, shown to users as "Shipment Production": 2D box-content text `AMZN,PO:<shipment>,FNSKU:…,QTY:…[,EXP:YYMMDD]`, Amazon box IDs `<shipment>U000001`, expiration dates; labels print in Source Correct's 4×6 layout with bwip-js served from `/vendor/bwip-js.min.js`; box numbers stay 1..N (a voided number is reused); a box's expiration is the one on Amazon's shipment for that product; finishing deducts through the same `applyShipItems` as a pasted pack slip), `inbound` (creating shipments from the app without Send to Amazon, Fulfillment Inbound v2024-03-20, "pack later" like Source Correct, because the floor can't know the boxes before it builds them: plan with just products + quantities (prep owner from Amazon's prep data; a missing expiration date is typed on the stopped plan) → placement options with fees, each warehouse with its city/state a pallet GUESS (`estimatePallets`) and a rough freight estimate ±25–35% (`lib/freight-est.js`: distance × per-pallet LTL rate, corrected by our own shipments' real freight); our own math, nothing sent to Amazon, because Amazon won't quote freight before a placement is confirmed (FBA_INB_0344) → confirm one (the FBA ID; the shipment lands in 2D Production with its destination) → the floor builds, labels and Finishes as for any shipment, box numbers 1..N → the built boxes are sent per shipment as 2D barcode (`shipmentBoxesBody`: BARCODE_2D, size and weight only — Amazon reads each box's contents off its label and refuses an item list; never BOX_CONTENT_PROVIDED, which ties contents to Amazon's own box numbering, seller SKU A→Z, and made the pilot's print-as-you-go labels wrong) and Amazon's box count is checked (`checkBoxIds`) → freight quotes from the floor's pallets (`floorPallets`) → book the freight (the charge: one tap on a pop-up showing the carrier and amount, the server re-checks the amount against the quotes, recorded the moment Amazon accepts so Retry never buys twice) → if the ship-from address needs a liftgate (on by default; Amazon's API has no liftgate field), a red "call the carrier for a liftgate truck" step stays on the plan and in 2D Production until ticked → BOL / pallet labels. Runs as background jobs in `inv_inbound_plans` (stage + args for Retry), warehouse login (owner's choice); ship-from addresses with contacts are a saved list; what's ticked on Pending Prep and on Prepped & Ready (as scanned: singles and duos; the same product on both is added together, since the floor sometimes works ahead) is added with one button, or "Send ticked to production" on either screen; nothing moves stock until Finish in 2D Production. The first version planned boxes up front (`planBoxes`, `amz_boxes`, `pickAmazonBoxes`); shipments made that way still work), `pallet` (pallet weight/height against the limits: planned to a safe 1,450 lb (Amazon's 1,500 minus a 50 lb margin), counting the pallet + wrap (70 lb), cardboard per box (1.5 lb) and a bag per unit (0.05 lb), all editable in Pallet limits; 60" incl. the 6" deck, height estimated in layers on the 48×40 footprint (a started layer counts its full height) unless measured; what fits next), `freight-est` (rough LTL estimate for the destination options: city coordinates, per-pallet rate by distance and weight, calibrated on our real freight bills), `checkin` (real Amazon check-in times; the typical one feeds Send Next's check-in days), `notify` (phone/email alerts; never throws), `capacity` (FBA capacity in cubic feet from package sizes; the limit itself isn't in the API, so the owner enters Seller Central's "Maximum shipment" — the room left — and the limit is worked out as what the app counts now + that room), `forecast` (the one demand number used by Send Next, Rec. Order, Pending Prep and On Hand: blends our sales corrected for days out of stock (from the `inv_fba_daily` snapshots), raw sales, SmartScout, Keepa and the even split of the pie, and learns the weights from a daily log scored 30 days later; then replaced by the other sellers' SmartScout average whenever there is one (`peerRate`, the owner's rule: never over-send — selling faster is a good problem, stock sitting at Amazon isn't; our own sales also undercount a listing we haven't kept in stock)). Also `weekly-email` (Sunday summary email), and `hazmat` (reading Amazon's hazmat answers: the listing's declared dangerous-goods regulation, where "unknown" stays unknown, and FBA Inbound Eligibility, whose reasons are codes (`HAZMAT_CODES`), not words; Amazon's code outranks the declaration; the scan saves each ASIN as it's answered and skips ones checked in the last 30 days, `inv_hazmat_checks`). No database access in the parsers. |
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
- `RECONCILE_LOOKBACK_DAYS`: the minimum look-back for shipment check-ins; the check reaches back to the oldest open app shipment anyway (`reconcileLookbackDays`, max 180).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `REPORT_EMAIL_TO`: the Sunday summary email (`lib/weekly-email.js`).
- `BACKUP_EMAIL_TO`: where the Sunday 3 AM backup goes (defaults to `REPORT_EMAIL_TO`, then `SMTP_USER`). Backups are every `inv_*`/`fin_*` table as gzipped JSON; download from Admin → Data Sources; restore with `scripts/restore-backup.js` (read its header first).
- `SPAPI_BASE_URL`, `LWA_TOKEN_URL`: local testing only (point the SP-API client at a fake Amazon). Never set in Railway. The two must differ, or the login call loops.
- `NTFY_TOPIC` (and optional `NTFY_SERVER`), `ALERT_EMAIL_TO`: phone/email alerts (`lib/notify.js`), e.g. when Amazon checks in or closes a shipment.

## Auth model (important)

- `auth` middleware: warehouse routes. Checks the `x-app-password` header and honors `AUTH_DISABLED`.
- `ownerAuth` middleware: checks the `x-owner-password` header. It does **not** honor `AUTH_DISABLED` and does **not** accept the app password. Staff must never see velocity, margin, cost, inventory value, settlements, or the P&L.
- Any new route that exposes money, cost, velocity, or value data must use `ownerAuth`. Hiding a screen in `index.html` is not protection.
- Owner-approved exception: New shipment (`/api/inbound/*`) uses `auth`, including confirming a destination and booking freight (the owner found the owner password unnecessary there). The charge step shows the amount in a confirm pop-up and the server re-checks it against the quote.
- Owner-approved exception: setting FBA capacity room left (`/api/capacity/limit`, cubic feet only) uses `auth`.
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
- **Large prep jobs:** a Pending Prep job over 200 is two linked halves (`split_group`, `split_part`; `lib/prep-split.js`) so two people each take one; a half someone is working never shrinks; a scan spills from part 1 into part 2; Prepped stays one row per product.
- **Next batch:** `inv_pending_prep.staged` rows are planned while the floor works the current list. Hidden from the floor's list (one grey line), never merged into a live job, refused by claim / crew / complete / prep scan, but counted as spoken-for stock like any pending prep. `POST /api/pending-prep/next/release` moves them onto the list (merge + split as if added then).
- **Shipped:** `inv_shipment_items` rows are bottles (a duo expands to its components, so On Hand and In Transit stay right); `shipped_as` records what the line went out as, so On Hand can show on-the-way singles and duo bottles apart (`transitSplit`).
- **Layout (owner's standing ask):** center and align everything so it reads at a glance. Numbers centered in their column; the same value sits in the same column all the way down (one table with a single header row, not cards that each lay out their own labels; `table-layout:fixed` or set widths when tables repeat); names/text left-aligned. Use `prodTh`/`prodTd` in 2D Production.
- **Product names (owner's standing ask):** most products come in 4–5 sizes, so wherever a product is named in a list, card or chart, show the size: `amzLinkSized(asin, name)` (short name + size tag, full title on hover; `listingSize` reads the size). Never cut a name off before its size.
- **Front end:** wrap any outside text (names, descriptions, error messages) in `esc()` before putting it into HTML. Check `d.ok === false` / `d.error` on every stock action and show the failure; never toast success without checking.
- **Amazon:** go through the `http` client in `spapi.js` (fresh token per request, timeout). Don't swallow errors into empty results — callers treat empty as "nothing there".

## Checking a change

```
npm test                                   # unit tests for lib/ (no database needed)
node --check server.js finance.js autorun.js spapi.js keepa.js
```

When you change a parser or rule in `lib/`, add a test for the case that
prompted it.

The stock-moving routes (receive, invoice complete, pending prep, prep scan,
ship, pack boxes, shipment received, undo, cycle count, On Hand fix count) have end-to-end tests in
`test/routes/`: a real server on a throwaway database, checking the counts
after double taps, simultaneous requests and repeats. They need a database
whose name contains "test" (it is wiped):

```
TEST_DATABASE_URL=postgres://.../elevate_test npm run test:routes
```

GitHub Actions (`.github/workflows/test.yml`) runs both suites on every push
and PR. When you change one of those routes, add a case to
`test/routes/stock.routes.test.js`. Other routes: check them against a local
Postgres (`DATABASE_URL=... npm start`) and in the browser.

## Workflow with the owner

- The owner has approved merging PRs without asking: once a change the owner asked for (or agreed to) is built and tested, merge its PR into `main` and say it's live. Railway deploys `main`.
- Still ask first for anything the owner hasn't agreed to, and flag clearly when a change affects stock counts, money or logins.
- After merging, start the next change from the latest `main`.

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
| `server.js` | The whole backend: schema/migrations (`initDb`), auth, ~270 `/api/*` routes, invoice parsing, receiving, prep, shipments, settlements, market data. Mounts `finance.js`, `autorun.js`, `ask.js` and `repricer.js` at the bottom. |
| `finance.js` | Owner finance screens (`/api/finance/*`): P&L, product profit, cash & draws, overhead, supplies, royalty, data sources. Owns the `fin_*` tables. Exported as `module.exports = (app, deps) => {...}`. |
| `autorun.js` | Weekly auto-refresh (`/api/auto/*`), Sundays 11:59 PM Arizona (always UTC-7, no DST). Calls the app's own endpoints in order, then snapshots the P&L. Catches up within six days if the server was down. |
| `spapi.js` | Amazon Selling Partner API client: LWA tokens, reports, settlements, FBA inventory, sales velocity, prices, catalog, inbound shipments/fees, hazmat, and `findInboundShipment` (one shipment's destination address and items, for 2D Production). |
| `keepa.js` | Keepa API client (market data, tracked ASINs, Product Finder for Brand Finder). |
| `index.html` | The entire front end: one large file with inline CSS/JS, served at `/`. |
| `dash2.js` | The Admin dashboard: sales panel, Top 50 sellers, the sales update card with its pixel-street loading bar. → `docs/screens.md` |
| `onhand2.js` | On Hand's cards and table (drawing only; `renderOnhand` in index.html still filters and sorts). → `docs/screens.md` |
| `look2.css` | The "new look" for every other screen, under `html.nl`. Styling only. → `docs/screens.md` |
| `look3.css`, `theme3.js` | The Bold look (`html.n3`, the default) and dark mode (`html.n3.dk`). Styling only. Fix a dark colour by its role in theme3.js's `MAP` or with a token in look3.css, never per screen in index.html. → `docs/screens.md` |
| `palette.js` | Search everything (⌘K): products, shipments, plans, invoices, screens. Navigates only. → `docs/screens.md` |
| `ask.js` | Ask Elevate: the owner's questions answered by Claude from the app's data, read-only tools, `ownerAuth`. → `docs/screens.md` |
| `repricer.js` | The night price drop (Admin → Prices → Repricer, `ownerAuth`); rules in `lib/reprice.js`. Changes real Amazon prices. → `docs/screens.md` |
| `sw.js`, `manifest.webmanifest`, `icons/` | The home-screen app (PWA): a service worker per `BUILD_ID`, never handles `/api/*`, and the "New version ready" bar. → `docs/screens.md` |
| `tablet.js` | Tablet mode for the floor, per device. → `docs/screens.md` |
| `lib/*.js` | Pure helpers moved out of `server.js` so they can be tested; no database access in the parsers. One section per module in `docs/lib.md`, including the long ones: `pack` (Shipment Production labels and boxes), `inbound` (creating shipments, box info, freight), `capacity` (FBA room left by storage type), `claims` (reimbursements). |
| `test/*.test.js`, `test/routes/` | `node:test` unit tests for `lib/` (`npm test`) and end-to-end tests for the stock-moving routes (`npm run test:routes`). |
| `scripts/restore-backup.js` | Restores a backup file into a database. Read its header first. |
| `docs/` | The long notes: `screens.md` (each front-end file), `lib.md` (each helper module), `rules.md` (the long domain rules). |
| `*.json` | Seed/reference data read at startup or by specific routes: `products.json` (catalog seed), `cosmo_map.json` (Cosmoprof item # → ASIN), `seed_costs.json`, `seed_fnskus.json`, `keepa_asins.json`, `smartscout_products.json` (products-to-add research). |

`server.js` and `index.html` are very large. Find things with grep (route
paths, function names, table names) and read the section you need rather than
the whole file.

**The docs are part of these instructions.** A line ending in → names the file
with the full note: the incident behind the rule, the function names, the
owner's exact words. Read that section before changing the code it covers, and
update it in the same change (this file keeps only the short version).

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
- `KEEPA_API_KEY` (`KEEPA_BASE_URL` points it at a fake for local testing only, never in Railway)
- `SELLER_ID`: our Amazon seller id (Merchant Token). The repricer needs it to change prices; without it the app tries to learn it from our offers.
- `RECONCILE_LOOKBACK_DAYS`: the minimum look-back for shipment check-ins; the check reaches back to the oldest open app shipment anyway (`reconcileLookbackDays`, max 180).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `REPORT_EMAIL_TO`: the Sunday summary email (`lib/weekly-email.js`).
- `BACKUP_EMAIL_TO`: where the Sunday 3 AM backup goes (defaults to `REPORT_EMAIL_TO`, then `SMTP_USER`). Backups are every `inv_*`/`fin_*` table as gzipped JSON; download from Admin → Data Sources; restore with `scripts/restore-backup.js` (read its header first).
- `SPAPI_BASE_URL`, `LWA_TOKEN_URL`: local testing only (point the SP-API client at a fake Amazon). Never set in Railway. The two must differ, or the login call loops.
- `ANTHROPIC_API_KEY`: Ask Elevate (ask.js) and reading paper invoices in Order Check-In (`lib/invoice-photo.js`). `ANTHROPIC_BASE_URL` can point it at a fake for local testing only (never in Railway).
- `NTFY_TOPIC` (and optional `NTFY_SERVER`), `ALERT_EMAIL_TO`: phone/email alerts (`lib/notify.js`), e.g. when Amazon checks in or closes a shipment.

## Auth model (important)

- `auth` middleware: warehouse routes. Checks the `x-app-password` header and honors `AUTH_DISABLED`.
- `ownerAuth` middleware: checks the `x-owner-password` header. It does **not** honor `AUTH_DISABLED` and does **not** accept the app password. Staff must never see velocity, margin, cost, inventory value, settlements, or the P&L.
- Any new route that exposes money, cost, velocity, or value data must use `ownerAuth`. Hiding a screen in `index.html` is not protection.
- Owner-approved exception: New shipment (`/api/inbound/*`) uses `auth`, including confirming a destination and booking freight (the owner found the owner password unnecessary there). The charge step shows the amount in a confirm pop-up and the server re-checks it against the quote.
- Owner-approved exception: setting FBA capacity room left (`/api/capacity/limit`, cubic feet only) uses `auth`.
- Owner-approved exceptions (for now, three trusted staff): `/api/ss-avg` (other sellers' average sales), `/api/our-sold30` (our own units sold per listing, last 30 days; owner 10/24 "show to everyone") and `/api/demand` (the best-estimate monthly sales per listing, for days covered on Pending Prep and On Hand) use `auth`. Revisit when per-person PINs or a separate staff link are added.
- Passwords are compared with `safeEq` (timing-safe), and login routes are rate limited (`loginLimiter`).
- **Owner devices (owner 11/4, "remember me" and Face ID):** `ownerAuth` also accepts a device key (`ot_…`) in the same `x-owner-password` header. "Remember me on this device" (Admin's unlock, ticked by default) gets a 180-day key from `POST /api/owner-device/remember` (password only, not a key); Face ID is a passkey (WebAuthn, ES256, `inv_owner_passkeys`) set up from Admin's "🙂 Set up Face ID", and each unlock (`/api/owner-passkey/login-options` + `login`, rate limited) has the server check the signature over its own challenge (rp id = the host, origin https, user verified) before issuing a 12-hour key. Keys are stored hashed (`inv_owner_devices`) and tied to the current `OWNER_PASSWORD` (`pw_fp`): changing it in Railway signs out every device and retires every passkey. 🔒 Lock revokes the device's key (`/api/owner-device/forget`). Devices keep only the key (localStorage `ownerKey`, `ownerPasskey` = the passkey id), never the password; the Admin unlock is a real form so the phone's keychain can save the password too. Requests with a key wait for the key list after a restart (`ownerKeysReady`) instead of refusing.

## Domain rules learned the hard way

These live in comments next to the code. Read the comment before changing the code.

- **Split deliveries:** one invoice number can arrive as several shipments (SHP#). Each is its own check-in (`262106088-2`, `lib/invoice-parts.js`); never merge a later delivery into a checked-in invoice.
- **Cosmoprof invoices repeat `FOR ORDER NUMBER:` on every page.** Merge all segments with the same order number *before* writing. Writes start with `DELETE ... WHERE order_number`, so writing page by page used to wipe earlier pages.
- **Invoice dates come in several formats** (`9/18/26`, `Sep 18, 2026`). `findInvoiceDate` normalizes them to M/D/YY.
- **New products from an invoice line:** "+ Add product to catalog" on an unlinked Order Check-In line (`/api/invoices/new-product`) adds the product and links the Cosmo# in one step, checks the ASIN with Amazon when it can (real title and picture), and never overwrites a product already in the catalog. The link starts unverified like any pick.
- **Cosmo-map entries are only trusted after a physical barcode scan confirms them** (`inv_cosmo_map.verified`). Seeded or hand-picked mappings start unverified.
- **Name-match suggestions never show a percentage.** Only a single, clearly winning match is offered, because workers treat a number as certainty.
- **Duo freight is its bottles' freight.** Shipments record a duo as its two bottles, so freight per unit exists per bottle, never under the duo ASIN; `context()` in finance.js gives a duo the sum of its bottles' rates (it used to carry $0 freight, which made duo margins look too high).
- **Stock at cost:** every retail value of the stock is shown beside the same units at product cost (`/api/stock-costs`, `ownerAuth`). A listing with units but no cost is counted and said (`costMissing`), never added as $0. → `docs/rules.md`
- **Hazmat:** a manual call by the owner always outranks Amazon's declaration (`hazmat_source`).
- **Smart Scout Orders Total** (owner 11/5, "so I can see where I'm lacking"): both views have a sortable Total column after On the way: on hand + on the way + at Amazon. By bottle: bottles (`r.onhand + r.atAmz + r.way`); by listing (`listingTotal`): a single's bottles on hand (its prep included) or a duo's duos buildable from free bottles + duos in prep, + on the way + at Amazon. The bottle view's listing sub-rows show the listing's total too (`nAfter` counts the column).
- **Our own sales are never SmartScout's guess:** our units always come from `inv_sales_asin_daily` (`ourLast30`, `/api/our-sold30`). SmartScout's estimate of us is not shown and is not a forecast signal. → `docs/rules.md`
- **One ASIN, several Amazon listings:** a product keeps one SKU + FNSKU and the sync only refreshes that SKU's FNSKU. `lib/fnsku-pick.js` switches or asks when the listings change; a FNSKU set by hand is pinned (`fnsku_pin`). → `docs/rules.md`
- **P&L is current, settlements correct it:** finance.js `aggregate` adds the money-event lines Amazon hasn't settled (`inv_fin_event_lines`) as an estimate, and each settlement replaces its estimate. Top 50's Amazon rates stay settled-only. → `docs/rules.md`
- **Freight line status** (owner 10/30: "Pull fees from Amazon" never cleared it): a sold unit with no freight per unit is only a gap (amber) when it came from a received app shipment with no freight / placement on file (`ctx.noFee`, `freightNoFeeUnits`, `noFeeShips`, named in the banner); units from stock the app never shipped are covered by what Amazon billed for shipments not in the app, charged as billed, and don't hold the line amber.
- **Loan payments:** a Rent & overhead item whose category contains "loan" is its own P&L line under Royalty, the whole payment, and net reads "NET (WHAT'S LEFT OVER)". → `docs/rules.md`
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
- **Pending Prep can't go past the shelf:** adding or raising a job beyond what is free is refused (`notEnough`; `duoShortfall`, `singleShortfall`) under a per-bottle advisory lock. → `docs/rules.md`
- **How it sells, on Pending Prep and Prepped & Ready:** `sellStrip(asin)` shows Sold 30d, In stock, 3P avg, At Amazon, Days and Rank; Prepped & Ready also has the FBA capacity gauge (`renderPrepCap`). → `docs/rules.md`
- **FBM orders come off warehouse stock:** each SHIPPED FBM line is taken off On Hand once (`applyFbmOrders`, `inv_fbm_orders`, `lib/fbm.js` `planTake`). A unit found nowhere is not taken and is logged for a hand fix. → `docs/rules.md`
- **Prepped:** stored as scanned (single under its ASIN, duo under the duo ASIN). Use `consumePrepped` when shipping.
- **Send back to On Hand:** `POST /api/pending-prep/remove` deletes the picked jobs in one transaction. No stock moves. → `docs/rules.md`
- **Duo items vs Duos I can build:** two different counts on purpose, each saying so. `/api/bundles` returns every duo, in the catalog or not. → `docs/rules.md`
- **DO ALL** (owner 11/5): the Request Prep / Prelabeling window has a green "✅ DO ALL (N)" button under the choices: everything free on the shelf, or, with a duo picked, every duo that can be built (`prepDoAll`, the count follows the pick, `prepDoAllLabel`), added at once through the same `submitPrepRequest` (same checks, current list / next batch as chosen).
- **Large prep jobs:** a Pending Prep job over 200 is two linked halves (`split_group`, `split_part`; `lib/prep-split.js`) so two people each take one; a half someone is working never shrinks; a scan spills from part 1 into part 2; Prepped stays one row per product.
- **Next batch:** `inv_pending_prep.staged` rows are planned while the floor works the current list. Hidden from the floor's list (one grey line), never merged into a live job, refused by claim / crew / complete / prep scan, but counted as spoken-for stock like any pending prep. `POST /api/pending-prep/next/release` moves them onto the list (merge + split as if added then).
- **Prelabeling only:** `inv_pending_prep.prelabel` jobs are their own jobs, never part of a shipment. Finishing one adds to `inv_prepped.prelabel_qty`, which a trigger keeps ≤ qty. → `docs/rules.md`
- **Shipped:** `inv_shipment_items` rows are bottles (a duo expands to its components, so On Hand and In Transit stay right); `shipped_as` records what the line went out as, so On Hand can show on-the-way singles and duo bottles apart (`transitSplit`).
- **Readability rules:** one colour per meaning (warehouse teal, Amazon blue, sales purple; red / amber / green only for status), numbers in shaded column groups, a status chip leading every card, ID chips in a fixed stack. → `docs/rules.md`
- **Layout (owner's standing ask):** center and align everything so it reads at a glance. Numbers centered in their column; the same value sits in the same column all the way down (one table with a single header row, not cards that each lay out their own labels; `table-layout:fixed` or set widths when tables repeat); names/text left-aligned. Use `prodTh`/`prodTd` in 2D Production.
- **Sortable lists (owner's standing ask):** every list or table with numbers sorts by clicking a column header: numbers highest first, text A→Z, a second click flips it. Use `sortState` / `sortTh` / `sortRows` in index.html (Admin's older tables have their own sort functions, e.g. `fbaSort`).
- **Product names (owner's standing ask):** most products come in 4–5 sizes, so wherever a product is named in a list, card or chart, show the size: `amzLinkSized(asin, name)` (short name + size tag, full title on hover; `listingSize` reads the size). Never cut a name off before its size.
- **Animations never hide content:** anything that fades or grows in must be visible at rest and animate FROM hidden (`animation-fill-mode: backwards`). `look2.css` turns every animation off under Reduce Motion; dash2.js cards that rested at opacity 0 left the owner's iPhone dashboard blank (10/24).
- **Sync with Amazon:** On Hand's button is the quick sync (about a minute); the 6:30 AM sync and "Run the full sync now" read every report. A listing Amazon has no size for is a note, not a problem. → `docs/rules.md`
- **Inventory Value:** prices 20 ASINs a call (`getMyPrices`), covers every listing at Amazon whether it's in the catalog or not, and runs with the full morning sync. → `docs/rules.md`
- **Brand Finder:** Admin → Planning → Brand Finder (`lib/brand-finder.js`, `/api/brand-finder/*`, `ownerAuth`): Cosmoprof brands scored from Keepa and Amazon's offers, with the owner's marks, filters, retail prices and copyable ASINs. → `docs/rules.md`
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

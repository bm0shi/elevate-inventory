# lib/ — the pure helpers

Rules and parsers moved out of `server.js` so they can be tested (`test/*.test.js`,
`npm test`). No database access in the parsers. One section per module, in the
order the work flows; read the section before changing the module, and add a
test for the case that prompted the change.

Described elsewhere: `fnsku-pick`, `prep-split`, `finevents`, `brand-finder` (`docs/rules.md`),
`velocity`, `top-profit`, `prices` (`docs/screens.md`, the dashboard), `ask-sql`
(`docs/screens.md`, Ask Elevate).

## smartscout

SmartScout CSV exports uploaded in Admin → Smart Scout, and the pie: listing units minus Amazon's Buy Box share, split between third-party FBA sellers.

## demand

Our share of a listing's sales from the Buy Box split, used by Send Next and Suggested Orders.

## invoice-parse

Cosmoprof/Xstore parsing, `findInvoiceDate`.

## invoice-photo

Order Check-In's "📷 Paper invoice (photo or scan)", also used automatically when a PDF has no text inside (phone scans): `POST /api/invoices/read-photo` (`auth`) sends the photos / scanned PDFs to Claude (`claude-opus-5-5`, structured output, needs `ANTHROPIC_API_KEY`) and returns a preview with no prices (staff use it); `POST /api/invoices/add-photo` writes it through `writeInvoiceLines` with a one-use token. Each slip is saved as its own delivery, see `invoice-parts`.

## invoice-parts

Split deliveries, owner's rule: a big Cosmoprof invoice ships in pieces, each with its own slip and SHP#, sometimes a week apart and sometimes never, so each delivery is its own invoice in Order Check-In, checked in for what came: the first under the invoice number, later ones as `262106088-2`, `-3` (`inv_invoices.base_order`). The SHP# (`inv_invoices.photo_slips`, from a photo or a `SHP#` line in the text) stops a slip going in twice; rows without one match on identical lines. Text without a SHP# re-pasted onto an invoice not yet checked in replaces it, as before. A slip is refused rather than guessed into an invoice that is waiting to be checked in without slip numbers. `writeInvoiceLines` decides inside one transaction with an advisory lock per invoice number, so two slips at once can't both become -2. Checking in a later part takes its units off what earlier parts say Cosmoprof owes (`owedTakeoff`), so Shortages never asks for a credit on units that came.

## settlement-parse

Settlement flat files, `isPassThroughTax`, `INBOUND_FEE_PATTERNS`.

## homebase

Timesheet CSV.

## costs

`blendCosts`.

## matching

Invoice-line → product suggestions.

## codes

`normCode`, rack layout and locations, `badQty`.

## locations

Suggested pallet spots keeping duo partners side by side.

## restock

Amazon's restock report, shown beside our Send.

## pack

The 2D Production tab, shown to users as "Shipment Production": 2D box-content text exactly as Source Correct prints it (owner 10/20; decoded from their label): `AMZN,PO:<shipment>,FNSKU:<fnsku>, QTY:<n>,[EXPs:MM-DD-YYYY,]` per product, note the space before QTY and the trailing commas; the contents PDF417 is drawn at Source Correct's size too: error correction 6, 12 columns, bars 0.01238 in, rows 0.092 in, at 0.395 in / 4.21 in (`prodPrint`), Amazon box IDs `<shipment>U000001`, expiration dates; labels print in Source Correct's 4×6 layout with bwip-js served from `/vendor/bwip-js.min.js`; pallet labels too ("🏷️ PALLET LABELS", `prodPrint(null, pallets)`): their layout, the shipment ID as Code 128 (2.32 in wide) and sideways PDF417, the SHIPMENT-FC bar with the date, PALLET: n/N big at the bottom center (owner's choice), 4 per pallet; Amazon's own pallet-label PDF stays a second button; box numbers stay 1..N (a voided number is reused); BOXES LEFT reads "60 boxes of 12" with "+ 1 box of 4" under it (`prodBoxSplit`, owner 10/28: "61 · last box 4" confused the floor), and a product with no saved units per box uses the usual size, 6 for a duo and 12 for a bottle (`prodPerBox`, shown grey), so no row shows "—"; a product whose shipment qty is all built shows a green "✅ FULLY PACKED" with its pallets and box numbers and a button that opens those pallets and lights its boxes for reprinting (`prodShowBoxes`), instead of the red "more than the shipment needs" (owner 10/28); a built box only fills a product's blank case size / box size, never overwrites it (one odd box of 11 turned a 12-case into "11 per case" everywhere, owner 10/28; a one-time repair at start put sizes back from the most common box, `usualCaseQty`, logged in `inv_cache` `case_qty_repair_1028`); change a case size on purpose with On Hand's "per case ✎", the Duos / case column in On Hand's "Pairs into duos", or by tapping the case badge on a Pending Prep card; a duo's case is 6 duos unless set (`caseQtyOf`, owner 10/28 "duos are always 6 per case"), a bottle's 12; live across computers: every successful `/api/pack` POST bumps an in-memory counter per shipment, an open shipment polls `/api/pack/:sid/rev` every 1.5 s and reloads when it moved, keeping what's being typed (`prodLiveTick`, `_prodDirty`); a box's expiration is the one on Amazon's shipment for that product; finishing deducts through the same `applyShipItems` as a pasted pack slip.

## inbound

Creating shipments from the app without Send to Amazon, Fulfillment Inbound v2024-03-20, "pack later" like Source Correct, because the floor can't know the boxes before it builds them: plan with just products + quantities (prep owner from Amazon's prep data, which only fills an owner the product doesn't already have (`amz_prep_owner`, learned from an earlier refusal), and a prep category of its own (LIQUID, …) counts as SELLER even with no prep steps; when Amazon still refuses owners, the named products are fixed, remembered and the plan resent while each round fixes something new, up to 8, the fixes saved even when it stops, owner 11/5 HAZ plan; a missing expiration date is typed on the stopped plan; a SKU with no prep category at Amazon (FBA_INB_0182 "Prep classification for this SKU was missing", owner 11/5, two Awapuhi 5.1 oz: Send to Amazon asks for it on the spot, the API refuses the plan) stops the plan with a picker per product (`needsPrepCat`, `prepCategoryMissing`; `PREP_CATEGORIES` with what each means on the floor), pre-filled with the category most of our other SKUs carry (`prepCategorySuggest` over listPrepDetails of the catalog, `prepSuggest`); Save & retry (`/api/inbound/plans/:id/prepcat`) has part 1 set it at Amazon first (`setPrepDetails`, `prepDetailsBody`: our other SKUs' own prep steps for that category, else the usual ones; `prepCatSent` so Retry never sets it twice; prep owner SELLER, NONE for no prep) and send the plan again) (checked first, as Source Correct does before Submit plan, `planChecks`: a SKU on Amazon's stranded list (no active offer) or one Amazon answers 404 for is refused with the reason, since Amazon would refuse the whole plan; Amazon's WARNING problems on the created plan, e.g. the ship-from address not verified, are kept in `amz_warnings` and shown) → placement options with fees, each warehouse with its city/state a pallet GUESS (`estimatePallets`) and a rough freight estimate ±25–35% (`lib/freight-est.js`: distance × per-pallet LTL rate, corrected by our own shipments' real freight); our own math, nothing sent to Amazon, because Amazon won't quote freight before a placement is confirmed (FBA_INB_0344) → confirm one (the FBA ID; the shipment lands in 2D Production with its destination) → the floor builds, labels and Finishes as for any shipment, box numbers 1..N → the built boxes are sent per shipment as 2D barcode (`shipmentBoxesBody`: BARCODE_2D, size and weight only — Amazon reads each box's contents off its label and refuses an item list; never BOX_CONTENT_PROVIDED, which ties contents to Amazon's own box numbering, seller SKU A→Z, and made the pilot's print-as-you-go labels wrong) and Amazon's box count is checked (`checkBoxIds`) → AMAZON TAKES THE BOX INFO FOR EVERY SHIPMENT OF A PLAN IN ONE CALL (owner 11/5, a two-warehouse plan with one shipment built and the other not prepped until next week: a per-shipment call came back "Provided package grouping ids are incorrect. Expected all of [sh…, sh…]"), and the freight is quoted and booked for the plan as a whole too, with a readyToShipWindow PER SHIPMENT. So: `planSendBoxes` sends one `setPackingInformation` with every shipment's grouping; a shipment still being built goes as an ESTIMATE with the owner's say-so (`/boxes` answers `needs_estimate` with what it would send, the page shows it in full and resends with `estimate: true`): `estimateShipmentBoxes` = the boxes built so far + full cases for the rest from each product's case size, box size and unit weight (the same numbers 2D Production's BOXES LEFT shows; a product with none says so), box numbers carrying on after the last built box, recorded as `shipments[].estimated` {built, planned, boxes, lines}; its pallets are the built ones + `palletize` over the planned boxes (`estimated: true`). With 2D barcode labels only the box count, sizes and weights go to Amazon, so the floor just has to end at that count: 2D Production shows "AMAZON WAS TOLD N BOXES — M built so far" (`boxesExpected`), red at Finish when M ≠ N. The pallets step has a ready day per shipment when there are several (`readyDates`, an estimated one defaults to 6 days out), the plan-level date is the fallback. Booking marks each `shipments[].booked` ({at, carrier, cost, pickup}) the moment Amazon accepts (Retry books nothing twice), `confirmed` is rebuilt over every booked shipment, 2D Production's `planStage` is per shipment → freight quotes from the floor's pallets (`floorPallets`; freight class 70 on every quote, owner 10/31, was 85; Amazon's pickup day comes as midnight–11 PM UTC and is shown as that calendar day, `nsPickup`: shown in Arizona time it read as the evening before, so a "Monday" pickup was really Tuesday; the options are grouped by pickup day, the first 4 days with the best 5 each, partnered first then cheapest, with "Show every option", owner 10/31, `nsPickupDay`) → FREIGHT LOG (owner 11/8, "are you keeping track … so we can improve the estimates, split vs pay the placement fee?"): `GET /api/inbound/freight-log` (`auth`) lists each confirmed plan with the option taken (warehouses, placement fee), freight estimated → booked (`shipments[].booked`) → billed (`inv_shipment_costs` freight, source 'actual' from the settlement) per shipment with pallets estimated vs built and miles, the total and per unit, and "the other way": the cheapest estimated option of the opposite kind (single-warehouse vs split) it was chosen over; shown as "📊 FREIGHT SO FAR" under the plans list (`nsFreightBox`) with real-vs-estimate overall, and the destination table's freight column says how many shipments the estimate is learned from (`calibratedOn`). The learning itself is `freightCalibration`: the median of real ÷ model over the last 60 shipments with a freight cost, clamped 0.5–2 → (the placement fee confirmed and, at booking, each shipment's booked freight are saved as its inbound cost, source 'amazon', split by units when a plan has several shipments; a typed or settled figure is never overwritten, `saveBookedCost`, owner 11/1; plans confirmed before that are filled once at start, `backfillBookedCosts`) → book the freight (the charge: one tap on a pop-up showing the carrier and amount, the server re-checks the amount against the quotes, recorded the moment Amazon accepts so Retry never buys twice; ONE CARRIER FOR EVERY SHIPMENT OF A PLAN, owner 11/7: each shipment's own cheapest option came back FBA_INB_0354 "Requested transportation options do not have the same carrier as confirmed options", so with several shipments the page offers the carriers quoted for all of them with the total of each one's cheapest options (`_nsSel.carrier`, partnered first then cheapest), each shipment's list shows only that carrier, and `/confirm` refuses mixed carriers; a plan stopped at quoting or booking keeps the pallets and freight steps open (`stoppedAt`), and `/quote` and `/confirm` accept it, since nothing was bought) → if the ship-from address needs a liftgate (on by default; Amazon's API has no liftgate field), a red "call the carrier for a liftgate truck" step stays on the plan and in 2D Production until ticked → BOL / pallet labels. Runs as background jobs in `inv_inbound_plans` (stage + args for Retry), warehouse login (owner's choice); ship-from addresses with contacts are a saved list; what's ticked on Pending Prep and on Prepped & Ready (as scanned: singles and duos; the same product on both is added together, since the floor sometimes works ahead) is added with one button, or "Send ticked to production" on either screen; nothing moves stock until Finish in 2D Production. The first version planned boxes up front (`planBoxes`, `amz_boxes`, `pickAmazonBoxes`); shipments made that way still work.

## pallet

Pallet weight/height against the limits: planned to a safe 1,450 lb (Amazon's 1,500 minus a 50 lb margin), counting the pallet + wrap (70 lb), cardboard per box (1.5 lb) and a bag per unit (0.05 lb), all editable in Pallet limits; 60" incl. the 6" deck, height estimated in layers on the 48×40 footprint (a started layer counts its full height) unless measured; what fits next.

## freight-est

Rough LTL estimate for the destination options: city coordinates, per-pallet rate by distance and weight, calibrated on our real freight bills.

## checkin

Real Amazon check-in times; the typical one feeds Send Next's check-in days.

## notify

Phone/email alerts; never throws.

## capacity

FBA capacity in cubic feet from package sizes; the limit itself isn't in the API, so the owner enters Seller Central's "Maximum shipment" — the room left — and the limit is worked out as what the app counts now + that room; listings at Amazon that aren't in the catalog get their size into `inv_asin_sizes` (the lookup used to read the catalog only, so they stayed "no package size" for good, owner 10/30); a duo with no size of its own counts its bottles' sizes added up; the warning lists each listing with its reason and a ✎ to type a measured size (`POST /api/capacity/size`, `auth`, inches; a typed size is never looked up again); three buckets since 11/5 (owner: Amazon refused a plan with FBA_INB_0132 "exceeds the allowed volume for AEROSOL storage" after every other step, while Send to Amazon took 180 aerosols; flammables were approved to 100 cu ft, aerosols still 10): standard / flammable (`hazmat`) / aerosol, each with its own "Maximum shipment" in Set room left (`fba_capacity` `aerosol`/`aerosolRoom`) and its own line on Pending Prep's bar and Prepped & Ready's gauge. A product's bucket (`capacity.kindOf`): the owner's call (`inv_products.storage_type`, the Storage chip on New shipment's lines, `POST /api/capacity/storage-type`, `auth`; a 4th tap goes back to automatic), else Amazon's word (`storage_type_amz`, the planning report's storage-type column saved by the morning Stuck pull, `parseStorageTypes`/`saveStorageTypes`), else the hazmat flag with a name guess between aerosol (hairspray, mousse, foam, dry shampoo, Freeze and Shine…, shown "Aerosol ?") and flammable. BEFORE a plan is created (`/api/inbound/plans`, `capacity.planFit`): each bucket's cu ft added against the room left; over any limit, or aerosol units with no aerosol limit entered, is refused with `capacity: true` + `fit` and New shipment shows a red box per bucket (lines biggest first, cu ft, how many would fit alone, Set room left, Send anyway = `force`, which skips the check when Seller Central shows more room). A standard or flammable limit not entered is simply not checked. The bars on Pending Prep (`renderCapBar`) and Prepped & Ready (`renderPrepCap`) are the ROOM LEFT, filled by what's about to go (prepped + pending prep, pre-labeled striped); what's at Amazon and on the way is a grey note, since Amazon already took it off the Maximum shipment figure (owner 11/8: drawn against the whole limit with the stock at Amazon in blue, the bar read "3/4 full" with 928 units to send). The room left moves by itself with each stock pull (limit − today's stock at Amazon and on the way); only the typed figure goes stale, since Amazon sets a new limit each month and it isn't in the API, so the bar carries an amber nudge when the figure is from a previous month or over three weeks old (owner 11/8, "can you pull that daily?"). When Amazon still refuses a plan for a storage type (FBA_INB_0132 SORTABLE, owner 11/5 the same afternoon: the app's room-left figure was older than what Amazon counts), `capacityRefused` names the bucket, the refusal is saved on `fba_capacity` (`refused`, shown as a red line on the capacity bar until the room is re-entered, i.e. `setAt` newer) and the stopped plan's lines stay editable: `GET /api/inbound/plans/:id/fit` (each line's bucket, cu ft, how many would fit alone, each bucket's room) under "✎ Change quantities and send again" (`nsFitLoad`), `POST /api/inbound/plans/:id/items` (`{qty: {msku: n}}`, 0 removes a line, only before Amazon accepts the plan) saves and runs part 1 again, so a refused plan is cut in place instead of cancelled and rebuilt; also the Hazmat storage request, Admin → Checks → Hazmat storage (owner 10/30): pasted ASINs + quantities (`parseAsinQty`; a repeated ASIN is added up and shown) → `POST /api/hazmat-storage/calc` (`ownerAuth`) asks Amazon for each package size now (`sizeInches`, saved size as fallback, no calibration since it goes to Amazon) → the lines Seller Support asks for, "ASIN — volume per unit (Cu Ft) × units = total", to copy, and a CSV for their ASIN calculator.

## forecast

The one demand number used by Send Next, Rec. Order, Pending Prep and On Hand: blends our sales corrected for days out of stock (from the `inv_fba_daily` snapshots), raw sales, Keepa and the even split of the pie (not SmartScout's estimate of us, owner 10/23), and learns the weights from a daily log scored 30 days later; then replaced by the other sellers' SmartScout average whenever there is one (`peerRate`, the owner's rule: never over-send — selling faster is a good problem, stock sitting at Amazon isn't; our own sales also undercount a listing we haven't kept in stock).

## weekly-email

Sunday summary email.

## fbm

FBM orders off warehouse stock: where each sold unit is taken from, see the stock rules.

## returns

Amazon's FBA customer returns report, for the dashboard's Returns metric; table `inv_returns`, pulled with the full sales history and each morning for the last 60 days.

## stuck

Admin → Money → Stuck at Amazon: stranded units (no active listing, GET_STRANDED_INVENTORY_UI_DATA), unsellable and researching units (GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA) and aged stock with next month's surcharge (GET_FBA_INVENTORY_PLANNING_DATA, every `estimated-ais-*` column), parsed by column name; money tied up at cost; refreshed every morning, cache `stuck_stock`, a failed report keeps its last good list.

## claims

Admin → Money → Reimbursements, the reimbursement finder: shipments Amazon closed short (shipped vs received per SKU as Amazon counts it, `inv_inbound_recon`, so duo shortages show) less what Amazon already reimbursed for that SKU (`inv_reimbursements` from GET_FBA_REIMBURSEMENTS_DATA), and refunds 45+ days old with nothing returned or paid (refunds per order from the settlement lines already imported plus `inv_refund_orders` from the money events, the same refund counted once, against `inv_returns`); a value estimate, the latest Cosmoprof invoice as proof, and the case text. Claims are grouped into cases (`groupClaims`): one per shipment (every short SKU in it, one text) and one per order. Amazon has no API to open a case, so filing is: "▶ File them" walks the open cases one at a time (copy text → open Seller Central → type the case ID → Save & next, which marks every claim in the case Filed in one transaction), or "Let Claude do it" gives instructions for Claude in Chrome on the owner's computer to drive that same queue. A case turns Paid by itself when a reimbursement carries its case ID (`inv_claims`, with a snapshot). The check runs shipments first, then reimbursements (one 18-month report, monthly pieces only if Amazon can't build it), then only the returns history not already read; each part's claims show as it finishes. It never reads 18 months of money events (that took well over 20 minutes). The morning sync keeps reimbursements and shipment counts fresh.

## search

The ⌘K box's query patterns and product ranking.

## labor-split

Product Profit's labor per unit: the 90-day timesheet dollars split by each product's real prep time from `inv_prep_log` (crew person-seconds, median per product, jobs over 10 min/unit skipped), so a liter duo carries more than a 3 oz single and the total stays the same; flat rate when nothing is timed.

## health

Admin → App status: each background job and connection as green / amber / red with what to do, from `/api/status` (owner); the server keeps its last 50 errors since restart and alerts on a burst; the morning sync alerts when it has problems, the Sunday auto-run when it gives up.

## reprice

The repricer's time slots, drop price and restore rules, see `repricer.js`.

## hazmat

Reading Amazon's hazmat answers: the listing's declared dangerous-goods regulation, where "unknown" stays unknown, and FBA Inbound Eligibility, whose reasons are codes (`HAZMAT_CODES`), not words; Amazon's code outranks the declaration; the scan saves each ASIN as it's answered and skips ones checked in the last 30 days, `inv_hazmat_checks`.

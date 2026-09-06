# CLAUDE.md — EzPOS API Agent Instructions

This file is the source of truth for how Claude should work on this repo. Read this
and README.md fresh at the start of every session — don't rely on chat memory of
prior sessions to reflect current repo state; verify against the actual code.

---

## 1. Project Overview

**EzPOS** is a multi-tenant SaaS POS backend for restaurants and retail, owned and
developed solely by Nabil.

**Stack:** Node.js (ES modules), Express 4, raw SQL via `pg` (no ORM),
`node-pg-migrate`, `zod`, `bcrypt`, `jsonwebtoken`, `pino`, `stripe`, `resend`,
`ws` (WebSockets, added in 10.1 for the KDS).
Tested with `node:test` + `supertest` (plus a real `ws` client for 10.1, since
supertest cannot drive a WebSocket upgrade).

**Clients:** Next.js web dashboard (Vercel), Android/iOS native apps (till + KDS).

**Repo:** `https://github.com/md-motiur-rahman/ezpos_api.git` — canonical source of
truth. Always clone and verify actual repo state at the start of a session; the
project is consistently further along than any stored summary suggests, and this
repo has already caught real bugs (a route-mount line, a stale file) that only
showed up by checking the disk directly rather than trusting memory.

**Infra:** Render (Frankfurt, GDPR-aligned) with managed PostgreSQL, Next.js
frontend on Vercel, GitHub Actions CI/CD.

---

## 2. Architecture Fundamentals

- Shared-table multi-tenancy scoped by `company_id` / `shop_id`.
- UUID primary keys everywhere (`gen_random_uuid()`, PG13+).
- Soft-delete (`deleted_at`) on business records, with two deliberate exceptions:
  - Pure join/override tables with no independent existence (e.g. 6.4's
    `menu_item_modifier_groups`) — visibility is governed by the parent's
    `deleted_at`, not their own.
  - Records that represent an **already-applied state change** (7.6's receipts,
    7.7's wastage logs) — these are immutable once created, no PATCH/DELETE at
    all. Correcting a mistake goes through the resource's own manual correction
    endpoint (e.g. 7.1's `PATCH quantityOnHand`), not a reversal mechanism.
- Rotating opaque refresh tokens, stored server-side.
- Access tokens: JWT, 15 min. Staff sessions: DB-stored opaque tokens, sliding
  60-min window.
- DB-first Stripe operations with rollback rigor; one-time-per-company trial
  grant.
- `requireAuth` (owner JWT only), `requireStaffAuth` (staff session only),
  `requireStaffOrOwnerAuth` (accepts either on the same Bearer header — tries the
  cheap synchronous JWT check first, only falls through to a DB-backed staff
  session lookup if that fails).
- Actor pattern: `req.actor = { type: 'owner'|'staff', id, ... }`, set by
  `requireStaffOrOwnerAuth`.
- `resolveActorAuthority(actor, shopId)` + `assertHasPermission(...)` in
  `src/modules/staff/actorAuthority.js` — the shared permission-check mechanism
  used by every module below staff/auth itself.
- **"Derive, don't store"**: computed fields (e.g. `isBillingLocked`, 7.3's
  `isLowStock`, 7.5's `totalCost`, 7.6's `discrepancy`) are calculated at
  response time from current data, never persisted redundantly.
- Small, fixed, rarely-changing enums (6.5's `ALLERGENS`, 7.7's
  `WASTAGE_REASONS`) are JS code constants validated at the app layer, not a DB
  enum type or lookup table.
- **Route mounting order in `app.js` is load-bearing.** Any
  `/api/shops/:shopId/<resource>` mount MUST be registered before the broader
  `/api/shops` catch-all, or Express swallows the specific route into the
  broader (owner-only) router — producing a uniform 401 for every staff token
  regardless of actual role or permissions. This has caused a real, hard-to-trace
  bug (7.7) when a mount landed in the wrong position. `app.js` is always
  delivered as a full file, never as "add this line," because of exactly this
  risk.
- Bulk multi-row operations (insert or update) go through Postgres's `unnest()`
  pattern as ONE atomic statement rather than looped single-row queries — this
  project has no transaction wrapper anywhere, so single-statement atomicity is
  how correctness is maintained without adding one. Any such query is verified
  empirically against the real database (including edge cases like NULLs mixed
  with real values, and repeated calls against the same row) before application
  code is written around it — this has caught real bugs before they shipped
  (e.g. a same-statement CTE default-swap that looked correct but tripped a
  partial unique index mid-statement in 7.4).
- **`UPDATE ... FROM unnest()` silently applies only ONE delta per duplicated
  id.** Verified empirically in 7.9: passing the same target id twice in one
  call (deltas −1 and −2 against 10) lands on 9, not 7 — Postgres picks a
  single arbitrary match when the join matches multiple rows, and drops the
  rest with no error. **Any caller that could produce the same id twice MUST
  pre-aggregate in JS first** (7.9's engine does, keyed by
  `inventory_item_id`). Aggregating first is also exactly precise, where
  repeated separate writes accumulate rounding error against the 2dp
  `quantity_on_hand` column (0.125 applied 4× → 99.52; one −0.5 → 99.50).
  This is the highest-value empirical finding in the project so far — it
  would have shipped as a silent under-deduction bug with no error anywhere.
- **`pg` parses a `date` column as a JS `Date` at LOCAL midnight, not UTC
  midnight.** Caught in 8.2, the first `date` (as opposed to `timestamptz`)
  column in the schema. Server timezone is Europe/London; during BST
  (UTC+1) a stored `'2026-08-23'` reads back as `2026-08-22T23:00:00Z`, so
  `.toISOString().slice(0,10)` silently renders the PREVIOUS calendar day.
  **Format a `date` column back out with local getters
  (`getFullYear`/`getMonth`/`getDate`), never `.toISOString()` or the UTC
  getters** — those are correct for `timestamptz` (a real instant) but wrong
  for `date` (a calendar day with no timezone of its own). Caught by
  integration tests actually asserting the value, not by inspection.
- **`pg` returns every `numeric` column as a STRING, not a number.** Verified
  empirically in 9.5 before any money math was written. The failure mode is
  silent and expensive: `"10.00" + "5.55"` evaluates to the string
  `"10.005.55"` rather than `15.55`, with no error anywhere — a `+` on two
  un-converted amounts concatenates instead of adding. **Always `Number()` a
  numeric column before any arithmetic** (9.5 funnels every amount through a
  `toMoney()` helper). Relatedly: SQL `SUM()` over **zero rows returns NULL,
  not 0**, so any aggregate needs `COALESCE` — or, as 9.5 chose, sum in JS
  from rows already fetched, so one definition of the total exists rather
  than an aggregate that can disagree with the itemized list.
- **An `ON CONFLICT` clause targeting a PARTIAL unique index MUST restate
  that index's predicate.** Verified empirically in 9.7 before the code was
  written around it. For a `UNIQUE ... WHERE client_order_id IS NOT NULL`
  index, the insert must say `ON CONFLICT (shop_id, client_order_id) WHERE
  client_order_id IS NOT NULL DO NOTHING`. Dropping the `WHERE` does **not**
  silently fall back to a plain unique check — Postgres raises **42P10
  "there is no unique or exclusion constraint matching the ON CONFLICT
  specification"** and the statement fails outright. The predicate is how
  Postgres *identifies which index* the conflict targets, so it is
  load-bearing even though the value being inserted is obviously non-null.
  Confirmed in the same probe: on conflict the ORIGINAL row is preserved
  (never overwritten), rows with a NULL key never collide with each other,
  and the same key in a different shop is accepted. This pairing —
  partial unique index + `ON CONFLICT DO NOTHING` — is now the project's
  standard idempotency mechanism, used by both Module 3's
  `stripe_webhook_events` (Stripe retries) and 9.7's offline order queue.
- Shared cross-module helpers live in the repository file of the resource they
  actually operate on, not wherever first needed them — relocate and rename if a
  second module needs the same mechanism (e.g. `incrementInventoryQuantities`,
  built for 7.6's receiving, was relocated to `inventory.repository.js` and
  renamed `adjustInventoryQuantities` once 7.7's wastage needed the same
  mechanism with negative deltas).

---

## 3. Interaction Protocol

**Default: two-turn protocol.**
1. Nabil names a module/sub-module → Claude presents a **plan only** (scope,
   schema, endpoints, packages, open decisions, model recommendation) and stops.
2. Nabil gives feedback (still no code) or says "proceed" → only then does Claude
   implement.

**Relaxed mode (authorized for well-understood, incremental work):** Nabil may
say "plan and code at the same time." When this is granted:
- Claude may combine planning and implementation into one turn.
- Claude must still surface genuine design ambiguity as an explicit question
  **before** writing code — never assume on a consequential decision (data
  model shape, what mutates real state like stock quantities, permission
  requirements, etc.). "Plan and code together" means skip the *procedural*
  back-and-forth, not skip asking about real unknowns.
- When in doubt about whether something is "genuinely ambiguous" vs.
  "confidently inferred from established precedent," lean toward asking —
  getting a consequential decision wrong costs more than one extra question.

**Code delivery rules (non-negotiable, learned the hard way — do not relax):**
- **Every file is delivered in full, every time — never a diff, never a prose
  description of what changed, never "add this line here."** This single rule
  has been violated a handful of times in this project and each time produced a
  real, time-consuming bug (a route mount landing in the wrong position; a
  constant export not matching what was actually saved). If a file changed,
  paste the complete file.
- Before delivering any file as final, re-read it fresh from disk in the same
  turn — don't trust earlier context to still reflect the current state,
  especially after multiple edits.
- When several files change together (a feature plus its tests, a refactor
  spanning modules), deliver all of them together in one response.
- Code is evaluated (run, tested) before being called done, not just written and
  assumed correct.
- Reusable utilities are written once and reused, not duplicated per module.
- Avoid multi-turn "continue" patterns — completeness in one response is the
  goal.

**Verification discipline:**
- Before writing code around non-obvious SQL behavior, verify it empirically
  against the real database with a throwaway query first (see Section 2).
- After any change, run the full regression suite for every module that could
  plausibly be affected — not just the one being changed directly.
- If a bug only reproduces under full-suite load and never in isolation, treat
  that as a real signal (shared state, resource contention, ordering), not
  flakiness to dismiss.
- Prefer real diagnostic data (actual response bodies/status codes, actual file
  contents read fresh from disk) over a second or third theory. If a fix doesn't
  change the observed symptom, say so plainly rather than offering another
  guess — go get real data instead.
- Test files that log in as staff (PIN-based) should keep per-file login counts
  reasonable, given the staff-login rate limiter (10 attempts per 15 min,
  scoped per shop) — split into multiple files if one file would need many
  logins.

---

## 4. Module Roadmap

### Complete
- **Module 0** — Scaffolding, CI/CD
- **Module 1** — Owner auth
- **Module 2** — Company/shop management (plus `card_payment_mode`, added
  after 9.6 — see the entry at the end of Module 9)
- **Module 3** — Stripe billing (full): billing, webhooks, grace period/lockout,
  invoices
- **Module 4** — Staff permissions (4.1–4.6): schema, staff CRUD, PIN till auth,
  permission override system, staff hierarchy, audit log
- **Module 5** — Rota (5.1–5.4): shifts, swap requests, clock-in/out, attendance
  comparison
- **Module 6** — Menu management (6.1–6.5): master menu, per-shop
  overrides + local items, size variants, modifiers, ingredients/allergen
  tagging
- **Module 7 — Inventory (7.1–7.9, complete):**
  - **7.1** Inventory item CRUD (per shop)
  - **7.2** Recipe linking — extends 6.5's ingredients with quantities; links
    ingredients to items, variants, and modifier options, each with an
    editable portion quantity
  - **7.3** Low-stock alert thresholds — nullable per-item threshold, computed
    `isLowStock`, `?lowStockOnly=true` filter
  - **7.4** Supplier management — per-shop suppliers; many-to-many item↔supplier
    linking with one optional default per item, editable via PATCH (atomic
    swap, verified empirically)
  - **7.5** Purchase orders (logging only) — no workflow/status field, no
    automatic stock effect; multi-line-item orders, bulk-inserted atomically
  - **7.6** Stock receiving — multiple partial receipts per PO; receiving DOES
    increment `quantityOnHand` (confirmed directly, reversing 7.5's
    logging-only boundary on purpose); discrepancy is computed
    (`receivedQuantity - orderedQuantity`), not blocked
  - **7.7** Wastage management — fixed reason categories + optional notes;
    wasting more than current stock is blocked (409), not allowed negative
    (confirmed directly); decrements stock atomically; reading and logging
    share one permission gate (`VIEW_INVENTORY`), so Chef and any staff with
    that permission can do both, not just Managers (confirmed directly,
    overriding the original design)
  - **7.8** Centralized cross-shop inventory view — `GET
    /api/companies/mine/inventory-overview`, owner-only (`requireAuth`, not
    `requireStaffOrOwnerAuth`), since no staff role has authority spanning
    more than one shop anywhere in this system; flat list of every active
    item across every active shop in the caller's company, each row tagged
    with `shopId`/`shopName`; same `?lowStockOnly=true` filter and
    `isLowStock` computation as 7.3; works unrestricted for `business_type:
    'single'` companies too (trivially one shop's items), no gating on chain
    status
  - **7.9** Deduction engine — built on Opus. Two halves:
    - **`ingredient_inventory_links`** — the bridge that didn't exist before:
      company-level `ingredients` (6.5/7.2) ↔ shop-level `inventory_items`
      (7.1), unique on `(shop_id, ingredient_id)` so the engine gets exactly
      one answer per ingredient. Carries a `conversion_factor numeric(12,6)`
      (inventory units per 1 ingredient unit) — confirmed directly over
      requiring units to match, since recipes in grams against stock in 25kg
      sacks is a real case. CRUD hangs off the inventory item
      (`/api/shops/:shopId/inventory-items/:itemId/ingredient-links/…`),
      `MANAGE_INVENTORY` to write / `VIEW_INVENTORY` to read.
    - **`saleDeduction.service.js`** — `deductInventoryForSale(shopId,
      saleLines)`, deliberately **no HTTP route**: nothing user-facing should
      be able to move stock with no sale behind it, so Modules 9/10 will
      import and call it directly. (**Fulfilled by 10.3**, which is its one
      and only caller — reached through 10.2's item-status endpoint, with
      this file itself left completely unchanged.) Base item + variant +
      modifier recipes all
      **sum additively** (confirmed directly — deliberately NOT the same shape
      as 6.3's pricing, where a variant's price is absolute and replaces the
      item's; a variant lists only the EXTRA over the base). Never blocks on
      insufficient stock — goes negative, since the sale already happened and
      a silently-undeducted sale is worse than a visible negative (the
      opposite of 7.7's wastage 409, on purpose). An ingredient with no link
      (or one pointing at a soft-deleted item) is skipped and reported in the
      return value, never blocking the rest of the sale.
- **Module 8 — Health & Safety Add-on (8.1–8.4, complete):**
  - **8.1** Shelf-life configuration per inventory item — two nullable
    `integer` columns on `inventory_items`, `shelf_life_days` (sealed) and
    `shelf_life_opened_days` (once opened/prepped), confirmed directly as
    two separate durations rather than one, since a sealed item and an
    opened one run on genuinely different clocks. Whole days, not hours
    (confirmed directly — doesn't fit a same-day prepped item precisely,
    but matches the common case). No new endpoints — reuses the existing
    `POST`/`PATCH /api/shops/:shopId/inventory-items`, exact same
    nullable-and-optional "explicit null clears, omitted leaves untouched"
    contract as 7.3's `lowStockThreshold`. No cross-field rule forcing
    `shelf_life_opened_days <= shelf_life_days` — not asked for, so not
    invented. Also surfaced in 7.8's cross-shop overview, kept in sync.
    8.1 does NOT compute an expiry date or flag anything as expired — no
    event (receipt, prep) exists yet to measure the clock from; that's
    8.2/8.4's job once Module 9's order flow exists.
  - **8.2** Scan/SKU lookup → expiry calculation — new module
    `src/modules/healthSafety/`. Two parts:
    - **`sku`** added to `inventory_items` (nullable `text`, same
      nullable-and-optional contract as 8.1's fields), with a **partial**
      unique index on `(shop_id, sku) WHERE sku IS NOT NULL` — per-SHOP,
      deliberately not per-company or global: the same real barcode
      legitimately recurs across every shop in a chain, since each shop has
      its own separate `inventory_items` row. Verified empirically before
      building on it (duplicate SKU same shop → rejected; NULL SKUs never
      collide; same SKU across two shops → both allowed).
    - **`inventory_item_scans`** (immutable log, same shape as 7.6/7.7) —
      `POST/GET /api/shops/:shopId/inventory-scans` (+ `GET /:scanId`),
      confirmed directly to actually PERSIST every scan (not a stateless
      calculator), since 8.4's future auto-flagging will need real dated
      records to check against, not just a live per-request calculation.
      `{ sku, state: 'sealed'|'opened' }` in → looks up the item, picks
      `shelf_life_days` or `shelf_life_opened_days` per `state` (400 if that
      duration isn't configured — can't compute a required `expires_on`
      without it), computes `today + that duration`, writes the immutable
      row. Gated on **`PERFORM_HEALTH_SAFETY`**, confirmed directly over
      `VIEW_INVENTORY` — broadly available by default (Manager, Shift
      Manager, Server, Chef all have it), since expiry labeling is a
      floor-staff H&S task, not stock management; the response deliberately
      omits `quantityOnHand`/`lowStockThreshold` so `VIEW_INVENTORY`-gated
      data can't leak through the wider gate.
    - **Real bug caught before shipping**: `date` columns (this is the
      FIRST one in the schema — everything else is `timestamptz`) come back
      from `pg` as a JS `Date` at **local midnight**, not UTC midnight.
      Server timezone is Europe/London; during BST (UTC+1) a stored
      `'2026-08-23'` reads back as `2026-08-22T23:00:00Z`, so naively
      calling `.toISOString().slice(0,10)` on it silently renders the
      PREVIOUS day. Caught by the integration tests, not by inspection.
      Fixed by formatting with local getters (`getFullYear`/`getMonth`/
      `getDate`), not UTC ones, when reading a `date` column back out.
  - **8.3** On-screen expiry display + print trigger — purely additive on
    top of 8.2 (only new functions appended to the existing
    `inventoryScan.*.js` files; nothing in 7.x/8.1/8.2 was edited, verified
    via `git diff` showing zero deletions before this was called done).
    Two pieces:
    - **`GET /api/shops/:shopId/inventory-scans/latest`** — one row per
      inventory item that has been scanned at least once, showing only its
      MOST RECENT scan (`DISTINCT ON (inventory_item_id) ... ORDER BY
      scanned_at DESC`, verified empirically to pick the truly latest scan
      by time rather than insertion order before being relied on). Items
      never scanned don't appear. Registered in the router BEFORE
      `/:scanId` — same "specific route before the parameterized one"
      principle as `app.js`'s mount ordering (Section 2), just scoped to
      one router instead of the whole app; without this ordering,
      `/:scanId` would swallow the literal path segment `latest` and 400 on
      the UUID check instead of ever reaching this route.
    - **`inventory_item_scan_prints`** (new immutable table, same "already-
      applied event" pattern as 7.6/7.7/8.2) — `POST
      .../inventory-scans/:scanId/print` (+ `GET .../:scanId/prints` for
      history). Confirmed directly to persist every print as its own row
      rather than a stateless read: reprinting a damaged label is normal,
      not an error, so each print call creates a NEW row (same "multiple
      receipts per PO" precedent as 7.6) instead of overwriting anything.
      Response is a deliberately narrow `label: { itemName, sku,
      expiresOn }` — not the full scan record. Same `PERFORM_HEALTH_SAFETY`
      gate as the rest of 8.2, unchanged.
  - **8.4** Disposal/wastage auto-flagging — **flag-only, confirmed
    directly, no auto-deduction.** There's no batch/lot quantity tracked
    anywhere in this system (`inventory_items.quantity_on_hand` is a single
    aggregate, not per-delivery), so there is no quantity 8.4 could
    correctly guess for an auto-created wastage entry — inventing one would
    be exactly the silent-wrong-number risk this project has avoided
    elsewhere (7.9's conversion factors, 8.1's shelf-life duration). 7.7's
    wastage logging is completely unchanged; 8.4 never creates a
    `wastage_log` itself. Purely additive on top of 8.2/8.3 — only new
    functions/routes appended, verified via `git diff` (one line changed:
    an import statement expanded to add one more named import, not a
    behavior change).
    - **`GET /api/shops/:shopId/inventory-scans/expired`** — one row per
      item whose MOST RECENT scan (8.3's `/latest` logic) has passed its
      `expires_on` and has no resolution yet. Critical ordering, verified
      empirically before relying on it: latest-scan-per-item is picked
      FIRST (in a CTE), THEN filtered to expired-and-unresolved — filtering
      `expires_on <= today` before picking "latest" would incorrectly keep
      showing an item's stale expired scan even after a fresh rescan
      (non-expired) supersedes it. "Today" is a UTC-calendar string
      computed in JS and passed as a query parameter, NOT Postgres's
      `CURRENT_DATE` — one single definition of "today" behind both the
      expiry calculation (8.2) and this check, so the two can't silently
      diverge across server/DB timezone settings. Registered before
      `/:scanId`, same reasoning as `/latest`.
    - **`inventory_item_scan_resolutions`** (new immutable table, unique on
      `scan_id`) — `POST .../inventory-scans/:scanId/resolve` (+ `GET
      .../:scanId/resolution`), 400s if the scan hasn't actually expired
      yet, 409s if already resolved. A SEPARATE table from
      `inventory_item_scans`, not a column added to it — that table shipped
      immutable in 8.2 and stays that way. `wastageLogId` is **optional**,
      confirmed directly: a flag closes either by pointing at the 7.7
      wastage log that disposed of the item, or by plain dismissal (false
      alarm, already used up, mis-scanned) with no wastage behind it. When
      a `wastageLogId` IS supplied, it's validated to belong to the shop
      AND to actually cover this scan's item (checked against the wastage
      log's own line items, since one wastage log can span several
      different items) — without this check nothing would stop linking a
      completely unrelated wastage log.
    - **A standalone `todayUtcDateString()` helper was written for 8.4
      rather than reusing/refactoring 8.2's `calculateExpiresOn`** —
      deliberately, even though the two share a few lines of "today in
      UTC" logic. 8.2's function is previously-approved and already
      shipped; a small amount of duplication was judged the safer trade
      over touching tested code for a one-line saving.
- **Module 9 — Orders & Till System (9.1–9.8, complete):**
  - **9.1** Order creation — new module `src/modules/orders/`. **Scope note:
    9.1 and 9.2 (order items/modifiers/variants) were merged into one
    endpoint, confirmed directly** — every prior multi-line entity in this
    project (POs 7.5, receipts 7.6, wastage 7.7) creates header+lines
    together in one atomic request, and that precedent was chosen over an
    empty-shell-then-add-items-later flow. `POST /api/shops/:shopId/orders`
    requires a non-empty `items` array up front, matching that shape.
    - **Three new tables**: `orders` (header — `type`: `ORDER_TYPES =
      ['dine_in', 'takeaway']`; `table_number` free text, required iff
      `dine_in`, no Table entity anywhere in this system, confirmed
      directly; `customer_name` always optional; `status` — deliberately
      MINIMAL, `ORDER_STATUSES = ['open']` only for now, confirmed
      directly, extended later when 9.4/9.5 are actually designed rather
      than guessed at now; `created_by_actor_type`/`_id` follows the
      existing `req.actor` pattern), `order_items` (exactly one of
      `menu_item_id`/`shop_menu_item_id`, app-layer `.refine()`, not a DB
      `CHECK` — matches this project's convention; `unit_price`
      **snapshotted** at order time — charged/historical data, NOT subject
      to "derive, don't store"), `order_item_modifiers` (`price_delta`
      also snapshotted, kept itemized per-modifier rather than pre-summed
      into `unit_price`, for receipt-style itemization and future 12.x
      reporting). Item/variant/modifier **names are NOT snapshotted** —
      joined live at read time, same precedent as `listItemsForWastageLog`
      (7.7): soft-delete (not hard-delete) keeps the row available forever.
    - **Reuses `shopMenuService.getResolvedMenu(actor, shopId)` (Module 6)
      rather than re-deriving pricing/override logic** — that function is
      already override-aware (shop-level price/enabled overrides for
      items, variants, AND modifier options) and is explicitly documented
      in its own code as "what Module 9 (till) will eventually consume."
      Every order line is resolved against one call to it.
    - **Variant price is ABSOLUTE, replacing the item's own price; modifier
      `price_delta`s are ADDITIVE** — reuses 7.9's already-confirmed
      pricing semantics rather than re-deciding them.
    - **6.4's modifier group `minSelections`/`maxSelections` is enforced
      for the first time** — every group attached to an ordered item is
      checked against its own min/max regardless of whether the customer
      touched it (0 selections still fails a `minSelections > 0` group).
      Existed in the schema since 6.4 but nothing enforced it until an
      order flow existed to enforce it against. Verified NOT vacuous:
      temporarily disabled the check and confirmed exactly the two tests
      targeting it — and only those two — failed.
    - **3-statement atomic-per-statement write (header, then bulk
      `order_items`, then bulk `order_item_modifiers`)** — same
      no-transaction-wrapper constraint as everywhere else in this project;
      all lines are validated (against the resolved menu) BEFORE any row is
      written, to minimize partial-write exposure. `order_item` UUIDs are
      **pre-generated in JS** (`crypto.randomUUID()`) rather than
      correlated via `INSERT...RETURNING` row order, verified empirically
      before relying on it: explicit client-generated ids land correctly in
      a bulk `unnest()` insert, and an empty-array `unnest()` (an order
      with zero modifiers) is a safe no-op.
    - Response includes a computed `lineTotal` per item and `subtotal`
      ("derive, don't store") — **deliberately no VAT, no discount**; both
      are separate not-yet-built submodules (9.8, 9.3).
    - Gated on **`ACCESS_TILL`** (already existed; Manager/Shift
      Manager/Server have it by default, Chef doesn't).
    - Purely additive to the rest of the codebase — only `app.js` was
      touched among existing files (two lines: one import, one mount,
      before the broad `/api/shops` catch-all), verified via `git diff`
      showing zero deletions anywhere.
  - **9.2** Add items to an already-open order — `POST
    /api/shops/:shopId/orders/:orderId/items`, confirmed directly as 9.2's
    real remaining scope once 9.1 absorbed "items at creation": a real gap
    9.1 left (an order's items were otherwise fixed forever at creation
    time). Reuses 9.1's resolution logic (`resolveOrderLine` — pricing,
    enablement, variant/modifier rules, min/max enforcement) UNCHANGED and
    UNMODIFIED — same file, called again, not reimplemented. Rejects
    (400) unless `order.status === 'open'`; `ORDER_STATUSES` still only
    has `'open'` today so this can't actually fail yet, but it's written
    now because 9.4 (cancellation) will introduce a status where adding
    items must be blocked, and this is the natural place for that check to
    already live.
    - **One small in-file refactor, verified behavior-preserving**: the
      "pre-generate ids, bulk-insert items, bulk-insert modifiers"
      sequence was extracted out of `createOrder` into a shared
      `writeResolvedItems(orderId, resolvedLines)`, now called by both
      `createOrder` and the new `addItemsToOrder` — same calls, same
      order, nothing behavioral changed. Confirmed via `git diff` (the
      only deletions in the whole submodule are exactly this relocated
      block, moved verbatim) AND by re-running 9.1's own 23 tests
      unmodified afterward, specifically because this refactor touched
      `createOrder`'s internals and "don't change previously approved
      features" required proving it, not just asserting it.
  - **9.3** Discounts, order-level AND per-line-item (confirmed directly —
    both levels, over order-level only). New `discount_type`/`discount_value`/
    `discount_reason`/`discounted_by_actor_type`/`discounted_by_actor_id`/
    `discounted_at` columns on BOTH `orders` and `order_items`, same
    "explicit null clears, omitted leaves untouched" contract as 7.3/8.1.
    `DISCOUNT_TYPES = ['percentage', 'fixed']` — JS constant, same
    convention as `ORDER_TYPES`/`ORDER_STATUSES`.
    - **New `APPLY_DISCOUNT` permission**, deliberately separate from
      `ACCESS_TILL` (confirmed directly — not every till user should be able
      to discount). Manager and Shift Manager get it by default; Server and
      Chef don't, but — same as every permission in this system — can be
      granted it via 4.4's override system with zero extra code.
    - **Two endpoints**: `PATCH /api/shops/:shopId/orders/:orderId/discount`
      (order-level) and `PATCH
      /api/shops/:shopId/orders/:orderId/items/:orderItemId/discount`
      (per-line). Both take `{ discountType, discountValue, reason? }` to
      set or `{ discountType: null, discountValue: null }` to clear; both
      require `order.status === 'open'` (same guard 9.2 introduced); both
      return the full order detail, 200.
    - **Order-level discount applies to the subtotal AFTER any per-line
      discounts** — confirmed directly as the natural receipt-style
      ordering (itemized lines, already reflecting any per-item markdown,
      THEN a subtotal, THEN an order-wide discount code).
    - **Over-discount handling (confirmed directly)**: a `fixed` discount is
      REJECTED (400) if it exceeds the current amount it's applied against
      at the moment of applying — a line discount against that line's own
      pre-discount `lineTotal`, an order discount against the current
      subtotal-after-item-discounts. This is a point-in-time check, not a
      permanent guarantee, since 9.2 allows items to be added to an order
      after a discount is already set. As a read-time-only safety net for
      the resulting edge case (two independently-valid discounts, applied
      at different moments, compounding past zero), the final derived
      `total` is floored at 0 with `Math.max(0, ...)` — the apply-time
      rejection is the real defense, this is just insurance. A `percentage`
      discount can never trigger this on its own since it's already capped
      at ≤100 by the validation schema.
    - **Response contract is purely additive — proven, not just claimed**:
      `lineTotal` (per item) and `subtotal` (order) keep their EXACT prior
      meaning (pre-discount) and value for any order/item with no discount
      applied. New fields only: per item, `discount` (object or `null`) and
      `total` (post-discount); on the order, `itemDiscountTotal`,
      `discount`, `discountAmount`, `total`. Confirmed zero regression risk
      by re-running 9.1's 23 tests and 9.2's 11 tests completely unmodified
      after this submodule — all 34 passed with no changes, since every
      discount-related field defaults to `null`/`0` and every pre-existing
      field is untouched.
    - `order.repository.js`'s `findOrderItemForOrder` scopes by BOTH `id`
      AND `order_id`, so a line-item discount request can never reach an
      order item belonging to a different order (404, same "scoped to shop"
      precedent used everywhere else in this project).
    - 14 new tests in `orderDiscounts.test.js`, covering: percentage and
      fixed order discounts, over-discount rejection at both levels,
      explicit clearing at both levels, live recomputation after a 9.2
      add-items call, item+order discounts combining correctly (item
      discount applied first), cross-order item-id scoping, and the
      Manager/Server permission split.
  - **9.4** Cancellation (whole order) AND void (single line item),
    confirmed directly — both levels, same "both, not one" pattern as 9.3.
    New `cancelled_at`/`cancelled_by_actor_type`/`cancelled_by_actor_id`/
    `cancellation_reason`/`was_prepped` columns on `orders`; new
    `voided_at`/`voided_by_actor_type`/`voided_by_actor_id`/`void_reason`/
    `was_prepped` columns on `order_items`. `ORDER_STATUSES` gains
    `'cancelled'` — exactly the value 9.2/9.3 wrote their `status === 'open'`
    guards in anticipation of without knowing its name yet, so **those two
    submodules needed zero code changes**: adding items or setting a
    discount on a cancelled order is now correctly blocked by guards that
    already existed, confirmed by two regression tests that only pass
    because those old guards fire correctly.
    - **No KDS exists yet to detect prep state automatically** (Module 10 is
      still unbuilt), so `wasPrepped` is a REQUIRED boolean the staff member
      declares explicitly on the cancel/void request itself — confirmed
      directly, never auto-detected or defaulted.
    - **Flag-only, no auto-created wastage log** (confirmed directly, same
      precedent as 8.4) — auto-creating a 7.7 wastage entry would require
      resolving the order item down through recipe ingredients to inventory
      items and a guessed quantity, none of which this feature is scoped to
      do correctly. 9.4 only records that prep occurred; staff logs the
      actual wastage via the existing 7.7 endpoint themselves if needed.
    - **Two endpoints**: `POST /api/shops/:shopId/orders/:orderId/cancel`
      (whole order) and `POST
      /api/shops/:shopId/orders/:orderId/items/:orderItemId/void`
      (one line). Both `{ wasPrepped: boolean, reason?: string }`, both
      gated on **`ACCESS_TILL`** (confirmed directly — same gate as the rest
      of the orders module, not a new restrictive permission), both require
      the order still be `open`, both return the full order detail, 200.
      One-directional — no un-cancel/un-void, same "no reversal mechanism"
      philosophy as wastage/receipts.
    - **Voiding the LAST remaining active item on an order is rejected**
      (400, "cancel the order instead") — confirmed directly as the natural
      counterpart to `createOrderSchema` already requiring ≥1 item at
      creation; an open order silently ending up with zero active items
      would be an inconsistent state.
    - **Voided items stay in the `items` array** (audit trail, same
      soft-delete philosophy as everywhere else) but are **excluded from
      `subtotal`/`itemDiscountTotal`/`discountAmount`/`total`** — the one
      real logic change 9.4 makes to `toDetailResponse`, and it's a
      **provable no-op for every order with zero voided items**: totals are
      now computed over `items.filter(item => !item.void)`, which equals
      `items` whenever nothing has ever been voided - exactly why all 48 of
      9.1/9.2/9.3's own tests still passed completely unmodified afterward.
    - **Cancelling the whole order does NOT zero out `subtotal`/`total`** —
      confirmed directly: `status: 'cancelled'` is the authoritative "this
      isn't being charged" signal, the totals remain a record of what the
      order contained.
    - **One necessary touch to 9.3's code**: `setOrderItemDiscount` gained
      one new guard rejecting (400) an attempt to discount an already-voided
      item — a voided item is no longer part of the charge, so discounting
      it is meaningless. This is the only line 9.4 added to a 9.3 function;
      re-ran 9.3's own 14 tests unmodified afterward to confirm the
      non-voided path is untouched.
    - `order.repository.js`'s `cancelOrder` reuses `buildUpdateSet` (`orders`
      has an `updated_at` column); `voidOrderItem` hand-writes its `UPDATE`
      instead, same as 9.3's `setOrderItemDiscount`, because `order_items`
      deliberately has NO `updated_at` column (immutable line once created,
      per its original 9.1 migration) - `buildUpdateSet` unconditionally
      appends `updated_at = now()`, so it isn't reusable on that table
      without adding a column this schema intentionally doesn't have.
    - 13 new tests in `orderCancellation.test.js`, covering: order
      cancellation and its totals, double-cancel rejection, cancelled-order
      guards on 9.2/9.3 endpoints, line-item void and its total exclusion,
      last-active-item rejection, double-void rejection, cross-order
      item-id scoping, void-then-discount rejection, and the ACCESS_TILL
      permission gate.
  - **9.5** Payment processing (cash, card, split/partial) — **built on
    Opus**, per the roadmap's "elevated scrutiny" flag. New immutable
    `order_payments` table (same "already-applied state change" pattern as
    7.6/7.7/8.2 — no PATCH/DELETE; correcting a payment is 9.6's job via a
    new record, not by mutating this one). `ORDER_STATUSES` gains
    `'partially_paid'` and `'paid'`; `PAYMENT_METHODS = ['cash','card']`.
    - **`POST /api/shops/:shopId/orders/:orderId/payments`**, gated on
      **`ACCESS_TILL`** (confirmed directly — taking payment is an ordinary
      till operation, not a separate permission). **Split/partial payment is
      simply calling this more than once** — same "multiple receipts per PO"
      precedent as 7.6, rather than one row that gets topped up.
    - **The first payment LOCKS the order** (confirmed directly): status
      leaves `'open'`, and 9.2's `addItemsToOrder`, 9.3's discount setters
      and 9.4's cancel/void all guard on `status === 'open'` and simply stop
      matching. **Not one line in those three submodules had to change** —
      verified by three regression tests that pass *because* those existing
      guards fire, plus re-running all 61 of 9.1–9.4's own tests unmodified.
    - **Cash may be OVER-tendered, card may not** (confirmed directly).
      Cash credits `min(amountTendered, balanceDue)` and derives `change`
      ("derive, don't store"); a card charge exceeding the balance is
      rejected (400), since there's nothing to give change from. Input is a
      zod **discriminated union** on `method`, so the required field is
      method-specific (cash needs `amountTendered`, card needs `amount`) —
      something a single object with two optional fields can't express.
    - **`paymentProvider.js`** — the seam Module 13 plugs into. Deliberately
      **unlike `utils/stripe.js`**, which fakes only under `isTest` because
      it has a real backend the rest of the time: no vendor is chosen yet, so
      this touches no network in ANY environment. Callers depend only on the
      `{ success, providerReference, failureReason }` shape, never on how it
      was produced, so 13.1 swaps in a real SDK with no caller changes.
      A decline is returned, **not thrown** — a declined card is an ordinary
      business outcome the till must show the cashier, not an exception.
    - **The decline branch was proven non-vacuous** (same discipline as
      9.1's min/max check): `chargeCard` was temporarily forced to fail and
      the path confirmed to return **402, write ZERO payment rows, and leave
      the order at `'open'` with its balance untouched** — the provider is
      charged BEFORE anything is written, precisely so a failed charge needs
      no compensating delete (which this project has no transaction wrapper
      to make safe). Then reverted, and the full suite re-run.
    - **Empirically verified before the money math was written** (two real
      traps): (1) `pg` returns `numeric` columns as **strings**, so a naive
      `"10.00" + "5.55"` silently yields the string `"10.005.55"` instead of
      `15.55`, with no error anywhere — every amount now goes through a
      `toMoney()` helper first; (2) SQL `SUM()` over zero rows returns
      **NULL, not 0**. `amountPaid` is therefore summed in JS from the
      payment rows already fetched, so there's exactly one definition of
      "amount paid" and no aggregate that can disagree with the itemized
      list.
    - **Inventory is deliberately NOT touched** (confirmed directly) — the
      roadmap assigns the deduction trigger to **10.3**, so stock moves on a
      KDS event, not at payment time. 7.9's `deductInventoryForSale` is not
      called here.
    - Response gains `payments`, `amountPaid`, `balanceDue` — `[]`/`0`/full
      total for an unpaid order, so every field 9.1–9.4 returned is
      unaffected. `toDetailResponse`'s new `payments` parameter is
      **defaulted** (`= []`), so the signature change can't alter any
      existing caller's behavior.
    - **KNOWN LIMITATIONS, deliberately accepted and surfaced rather than
      hidden**: (a) the balance is read immediately before the insert, not
      inside a transaction — this project has no transaction wrapper
      anywhere (Section 2) and 9.5 does not introduce one, so two genuinely
      simultaneous payments on one order could both pass the balance check;
      narrow window given the single-till reality. (b) An order whose total
      is **£0** (e.g. a 100% discount) cannot be marked `paid` — a payment
      against it is rejected as "no outstanding balance". Closing a
      zero-balance order wasn't in 9.5's scope, so no action was invented
      for it; it stays `open`.
    - 22 new tests in `orderPayments.test.js`, covering: exact/over-tendered
      /partial cash, card success and over-balance rejection, cash+card
      split settling exactly, over-tender on the FINAL split payment
      crediting only the remainder, double-payment and cancelled-order
      rejection, all three lock-out guards, balance reflecting a 9.3
      discount and excluding a 9.4 voided item, method-specific validation,
      and the ACCESS_TILL split.
  - **9.6** Refunds, per payment, full or partial — built on Opus, same
    elevated-scrutiny bar as 9.5 (real money moving back out, extends the
    `paymentProvider` seam, and changes the `balanceDue` formula every order
    in the system reads). New immutable `order_refunds` table — same
    "already-applied state change" pattern as 7.6/7.7/8.2/9.5, no
    PATCH/DELETE. `order_payments` is NEVER mutated, exactly as its own 9.5
    migration comment anticipated ("correcting a payment is 9.6's job, via a
    new record").
    - **A refund targets a PAYMENT, not the order** (confirmed directly).
      `order_refunds.payment_id` references `order_payments`, with no
      redundant `order_id` of its own (same as `order_item_modifiers`
      reaching its order only via `order_items`). The reason is concrete: a
      card refund must reverse against that specific charge's
      `provider_reference`, which an order-level pool could not identify on
      a split cash+card order. **Partial refunds are simply calling the
      endpoint more than once** against the same payment — same "multiple
      payments per order" / "multiple receipts per PO" precedent, never one
      row topped up. Deliberately **no `method` column** — always the parent
      payment's, so a caller cannot ask to refund a card payment as cash.
    - **`POST /api/shops/:shopId/orders/:orderId/payments/:paymentId/refund`**
      (201 — it CREATES a row), gated on **`APPLY_DISCOUNT`** (confirmed
      directly), **reusing 9.3's existing permission rather than adding a
      `PROCESS_REFUND`** — giving money back is the same class of till
      discretion as marking an order down. Manager/Shift Manager hold it by
      default; Server/Chef don't but can be granted it via 4.4's override
      system with zero extra code. `permissions.js` was **not touched at
      all**.
    - **`ORDER_STATUSES` gains `'partially_refunded'` and `'refunded'`**,
      which **REPLACE** `'paid'`/`'partially_paid'` rather than sitting
      alongside them — a refund is one-directional, so an order entering the
      refund track stays there. Status is **recomputed across EVERY payment
      on the order**, not just the one refunded: fully refunding the cash leg
      of a split cash+card order correctly leaves it `'partially_refunded'`,
      not `'refunded'` (covered by its own test). `orders.status` is plain
      `text` with **no CHECK constraint** (verified in its 9.1 migration), so
      new values needed no schema change — same as 9.4/9.5.
    - **Zero code changes in 9.2/9.3/9.4/9.5** — their existing
      `status === 'open'` guards and `PAYABLE_ORDER_STATUSES` simply stop
      matching the new statuses. Proven by two regression tests that pass
      *because* those old guards fire, plus all 83 of 9.1–9.5's own tests
      re-run **completely unmodified**.
    - **DELIBERATE, flagged rather than hidden**: `'partially_refunded'` and
      `'refunded'` are NOT added to `PAYABLE_ORDER_STATUSES`, so once any
      refund is issued the order accepts **no further payment** (same
      one-directional philosophy as cancel/void/receipts). A partially-paid
      order that is then refunded therefore cannot be topped up — settle
      such a case as a new order.
    - **Response contract is purely additive — proven, not just claimed.**
      `amountPaid` deliberately keeps its exact 9.5 **GROSS** meaning; 9.6
      adds `amountRefunded` and `netAmountPaid` as NEW fields beside it, plus
      `refunds`/`amountRefunded`/`netAmount` per payment. `toPaymentResponse`
      gained a **defaulted** `refunds = []` parameter, exactly as 9.5
      defaulted `payments = []`, so the signature change cannot alter any
      pre-9.6 caller. **The one formula changed** is `balanceDue`:
      `total - amountPaid` → `total - netAmountPaid`, provably identical for
      every order that has never been refunded (`amountRefunded` is 0, so the
      two are equal) while correctly REOPENING the balance once money goes
      back out. `recordPayment` was switched to `netAmountPaid` for the same
      provable-no-op reason — correct by construction rather than by
      coincidence.
    - **Over-refund is rejected (400) at apply time** against that payment's
      own remaining refundable balance (`amount − refunds already issued`),
      which is exactly the `netAmount` the response exposes — computed by the
      **same `sumRefundAmounts` helper over the same rows**, so the figure
      validated against and the figure the till displays cannot diverge.
      Same "one definition of a total" discipline as 9.5's `amountPaid`.
    - **The card-refund decline branch was proven non-vacuous** (same
      discipline as 9.5's charge and 9.1's min/max): `refundCard` was
      temporarily forced to fail and the path confirmed to return **402,
      write ZERO `order_refunds` rows, and leave the order at `'paid'` with
      `amountRefunded: 0` and `balanceDue: 0`** — the provider is called
      BEFORE anything is written, precisely so a failed refund needs no
      compensating delete (which this project has no transaction wrapper to
      make safe). A cash refund was confirmed unaffected by the same forced
      card failure. Then reverted, and the full suite re-run.
    - **`paymentProvider.refundCard`** — a SEPARATE function extending the
      same interface rather than a mode on `chargeCard`, exactly as 9.5's own
      comment in that file anticipated. Takes the ORIGINAL charge's
      `providerReference` as the thing being reversed and returns the
      refund's OWN distinct reference (asserted different in a test); same
      `{ success, providerReference, failureReason }` contract, so 13.1 swaps
      in a real SDK with no caller changes.
    - **Empirically verified before the money math was written**: `numeric`
      again confirmed to return **strings** on this new table (the
      `'1.11' + '2.22'` → `'1.112.22'` concat trap is real), and
      `numeric(10,2)` was found to **silently round a 3dp input**
      (`0.005` → `0.01`). The code rounds in JS **first** and uses that one
      rounded value for both the cap check and the insert, so JS's and
      Postgres's rounding can never disagree.
    - **KNOWN LIMITATION, deliberately accepted** (identical in shape to
      9.5's): the refundable balance is read immediately before the insert,
      not inside a transaction — this project has no transaction wrapper
      anywhere and 9.6 does not introduce one, so two genuinely simultaneous
      refunds against the same payment could both pass the check. Narrow
      window given the single-till reality.
    - 21 new tests in `orderRefunds.test.js`, covering: the additive
      no-refund baseline, full/partial cash refunds, two partials
      accumulating to `'refunded'`, card refund with a distinct provider
      reference and an unmutated payment row, over-refund rejection both
      outright and against the REMAINING balance, already-fully-refunded
      rejection, split cash+card refunded one leg then both, a
      partially-paid order refunded, refund capped by a 9.3 discount rather
      than the pre-discount subtotal, open/cancelled status gates,
      cross-order payment-id scoping (404), validation, all four lock-out
      guards, and the Manager/Server `APPLY_DISCOUNT` split.
  - **Company card payment mode (cross-cutting, added after 9.6)** — built
    on Opus. Some shops already have their own bank-supplied card terminal,
    so card processing is now a per-COMPANY choice made at setup:
    `companies.card_payment_mode`, `'platform'` (our provider) or `'own'`
    (their terminal). Owner-only `POST
    /api/companies/mine/card-payment-mode`, its own dedicated action rather
    than part of the generic `PATCH /mine` — exactly the same shape and
    reasoning as `business-type`, since this decides how money is actually
    taken. Surfaced as `cardPaymentMode` on every company response.
    - **`NOT NULL DEFAULT 'platform'`, deliberately UNLIKE `business_type`**
      (which is nullable with no default because it's a genuine onboarding
      decision that must be stated). The default is the whole regression
      strategy: every pre-existing company and every caller that never
      mentions the field keeps exactly today's behaviour, so 9.5/9.6 are
      unaffected **by construction rather than by remembering to re-test**.
      Verified empirically after migrating: all 20,857 existing companies
      backfilled to `'platform'`, zero NULLs.
    - **`'own'` mode skips the provider entirely.** The till still offers
      cash/card and still records the transaction as `method: 'card'` with
      full card semantics (fixed `amount`, capped at the balance, no
      over-tender/change) — it simply never calls `chargeCard`, so
      `provider_reference` is null, exactly as cash has none. There is
      nothing for us to charge; the money was taken out of band on their
      machine, and faking a reference would invent a transaction we never
      made.
    - **The bypass was proven non-vacuous** (same discipline as 9.5/9.6's
      decline branches): `chargeCard` was temporarily forced to FAIL, and
      `'platform'` mode correctly returned **402** while `'own'` mode still
      returned **201 / `paid` / null reference** — proving it genuinely
      never reaches the provider rather than merely producing a null by
      coincidence. Then reverted and the full suite re-run.
    - **Refunds key off the PAYMENT's own `provider_reference`, NOT the
      company's current mode** — the single most important decision here.
      An owner can switch terminals between taking a payment and refunding
      it, and reading the live setting would be wrong in *both* directions:
      it could skip reversing a charge our provider really did take (money
      left sitting on a customer's card) or call the provider to reverse a
      charge it never made. A payment that HAS a reference was processed by
      us and must be reversed by us; one without was taken on their terminal
      and is refunded there, out of band. Correct by construction whatever
      the setting says today, and needing no extra schema —
      `order_payments.provider_reference` already encodes the fact. Two
      tests cover the switch in each direction.
    - **`findCompanyByShopId`** (new, in `company.repository.js`) — the till
      resolves the company from the SHOP, because a staff-authenticated
      payment never carries the owner's user id, so `findActiveCompanyByOwner`
      can't be reused. Written as a subquery rather than a JOIN specifically
      so the existing `COLUMNS` constant is reused verbatim with no alias
      prefix — one definition of the column list, no second copy to drift.
      Verified to return null for both a missing and a soft-deleted shop.
    - `usesPlatformCardProcessing()` falls back to `'platform'` if the
      company row or column were ever absent — the pre-existing behaviour;
      defaulting the other way could silently skip a real charge.
    - 14 new tests in `cardPaymentMode.test.js`: the default, switching both
      ways, persistence via `GET /mine`, invalid value, no-company 404, the
      generic PATCH being unable to set it, platform mode still producing a
      reference, own mode's null reference / balance cap / cash being
      untouched / cash+card split, own-mode refund, and both mode-switch
      refund directions. All 699 pre-existing tests re-run **completely
      unmodified**.
  - **9.7** Offline sync — an idempotent queue of sales the till rang up and
    took payment for while it had no connectivity. Built on Opus, per the
    roadmap's "elevated scrutiny" flag. **`POST
    /api/shops/:shopId/orders/sync`**, gated on **`ACCESS_TILL`** (the same
    gate as the rest of the till, not a new permission — `permissions.js` was
    not touched). Three new NULLABLE columns on `orders` (`client_order_id`,
    `occurred_at`, `sync_payload_hash`) plus a partial unique index; **no new
    table**, and **`app.js` was not touched at all**, so there was no
    route-mounting risk of the kind that bit 7.7.
    - **The nullability IS the regression strategy**, same reasoning as
      `card_payment_mode`'s default: every pre-existing order and every order
      created through 9.1's online `POST /orders` has all three as null, so
      9.1–9.6 are unaffected **by construction rather than by remembering to
      re-test**. Confirmed by all 713 pre-existing tests re-run **completely
      unmodified**, and by a test asserting an online order still reports
      `clientOrderId: null` / `occurredAt: null` with its old totals intact.
    - **Idempotency is delegated to Postgres, not implemented in JS.** A
      partial unique index on `(shop_id, client_order_id) WHERE
      client_order_id IS NOT NULL` plus `ON CONFLICT ... DO NOTHING
      RETURNING` — the **identical mechanism Module 3 already uses** for
      Stripe's retried webhook deliveries (`stripe_webhook_events`), reused
      rather than reinvented. Per-SHOP, not global: two tills generate their
      own ids independently and may legitimately collide across shops (same
      per-shop reasoning as 8.2's SKU index).
    - **EMPIRICALLY VERIFIED before any code was written around it, and a
      real trap**: an `ON CONFLICT` clause targeting a PARTIAL index **must
      restate the index predicate** (`... WHERE client_order_id IS NOT
      NULL`). Omitting it does NOT silently fall back to a plain unique
      check — Postgres raises **42P10 "there is no unique or exclusion
      constraint matching the ON CONFLICT specification"** and the insert
      fails outright. Also confirmed in the same probe: the ORIGINAL row is
      preserved on conflict (never overwritten), NULL keys never collide with
      each other (three inserted cleanly), and the same key in a second shop
      is accepted.
    - **Replay vs. key collision (confirmed directly)** — the unique index
      alone cannot tell these apart, so a SHA-256 `sync_payload_hash` of the
      canonicalized payload does: same key + same payload → the ORIGINAL
      order, **200** (`created: false`, nothing written); same key +
      DIFFERENT payload → **409**, rejected rather than silently returning an
      order that doesn't match what was sent, which would leave a real sale
      unsynced with nothing to indicate it. The 200/409 pair is a proper
      differential proof that the hash is what distinguishes them. First sync
      is **201** — the only handler in this module whose status isn't fixed,
      hence `syncOfflineOrder` returning `{ order, created }` rather than the
      order alone.
    - The canonicalizer is built **field by field in a fixed order from the
      validated data**, not by hashing the raw body: money is normalized
      through `roundMoney` and `occurredAt` through `toISOString()`, so a
      client that reformats its own queue entry between retries (`10` vs
      `10.00`, `...T18:30:00.000Z` vs `...T19:30:00+01:00`) gets a correct
      200 rather than a spurious 409. Both covered by tests.
    - **Client-snapshotted prices are TRUSTED as historical fact (confirmed
      directly)** — `resolveOfflineOrderLine` is deliberately NOT 9.1's
      `resolveOrderLine`, which is left completely unmodified. The cash is
      already in the drawer at the price the customer was charged, so
      re-pricing against a menu that may have changed since would make the
      record disagree with the receipt they're holding. Consequently the
      offline path also does **not** check `isEnabled` (an item 86'd after
      the sale must still sync) and does **not** re-enforce 6.4's modifier
      min/max (the offline till enforced it at sale time against its cached
      menu). Both proven by tests, including one asserting the ONLINE path
      still rejects the same min/max case — so the relaxation is scoped to
      sync, not a hole punched in 9.1.
    - What IS still enforced is **tenancy and referential integrity**: the
      item must exist in THIS shop's resolved menu and any variant/modifier
      option must genuinely belong to that item, else 404 with nothing
      written. Without it an offline payload could name another company's
      menu item. Three tests cover this.
    - **PAYMENT SCOPE: cash, plus card ONLY for `'own'` `card_payment_mode`.**
      A `'platform'` card sale is rejected **400** — our provider must be
      reached live to authorise a card, so a queued one could not
      legitimately exist, and accepting it would record money as taken that
      nothing ever charged. `'own'` mode is genuinely offline-capable, so no
      provider is called and `provider_reference` stays null — which means
      **9.6's refund path keys off that null and correctly declines to
      reverse a charge our provider never made**, covered by a test. The
      rejection was **proven non-vacuous** (same discipline as 9.5/9.6's
      decline branches): disabling the check made **exactly one test fail —
      and only that one**. Then reverted.
    - **A REAL BUG WAS CAUGHT AND FIXED before the first test run**: the
      card-over-total check originally threw AFTER the order header and items
      were inserted. That would leave an orphaned order **and permanently
      burn that `clientOrderId`** — the unique index would then match every
      honest retry against the half-written row, so the till could never sync
      that sale. Restructured so **every throw sits above the first write**
      (the total is derived from the resolved lines pre-insert, via
      `computeResolvedLinesTotal`). **Proven non-vacuous**: temporarily moving
      the throw back below the insert makes the test fail with `actual: 1,
      expected: 0` orders. The test asserts both that a rejection leaves zero
      rows AND that retrying the same key then succeeds.
    - **`numeric(10,2)` silent-rounding, re-confirmed empirically** (the 9.6
      lesson): a 3dp client price must be settled to 2dp in JS **once**, and
      that one value used for BOTH the pre-insert total and the insert, or
      the two disagree. Verified against the real DB that JS
      `Number((0.125).toFixed(2))` and Postgres `0.125::numeric(10,2)` both
      give `0.13`. **This caught a wrong test expectation, not a code bug** —
      the implementation was already correct and self-consistent; the test
      had assumed the line total came from the raw `0.125`.
    - `writeResolvedItems` is reused as its **THIRD caller, completely
      unchanged**; `recordPayment` was deliberately **NOT refactored** to
      share its cash math — that function is previously-approved and covered
      by 36 money tests, and the overlap is three lines of arithmetic, so a
      little duplication was the safer trade (**exactly the judgement 8.4
      made** in writing its own `todayUtcDateString` rather than touching
      8.2's tested code). The result is **zero changes to any 9.5/9.6 logic**.
    - **`payment` is REQUIRED (scope decision, flagged not assumed)** — the
      roadmap names this a cash-order QUEUE, i.e. completed transactions. An
      offline order with nothing charged has no reason to be queued; it can
      be rung up normally once connectivity returns.
    - A synced order is **locked exactly as a paid online order is** — 9.2's
      add-items and 9.3/9.4's discount/cancel guards stop matching because
      the status is `paid`/`partially_paid`. **No new `ORDER_STATUSES` value
      was needed**; `orderConstants.js` was not touched.
    - **KNOWN LIMITATIONS, deliberately accepted and surfaced**: (a) the
      header/items/payment writes are separate statements, not a transaction
      (this project has no wrapper anywhere and 9.7 adds none) — two
      simultaneous syncs of one key still cannot produce two orders, the
      index prevents that outright, but the loser could read the order back
      in the instant before its items land; a retry returns it complete.
      (b) `getResolvedMenu` excludes SOFT-DELETED items, so an item deleted
      between the offline sale and the sync 404s and cannot currently be
      synced.
    - 35 new tests in `orderOfflineSync.test.js`. Total suite **748 passing**,
      with only **2 deleted lines** across the whole submodule — a column-list
      line gaining a continuation and one doc comment extended, neither a
      behaviour change (verified via `git diff`).
  - **9.8** VAT calculation on orders/receipts — built on Sonnet (no elevated-
    scrutiny flag on the roadmap for this one, and the confirmed scope came in
    simple enough to match: no new table, no new endpoint, no new permission).
    One new NULLABLE column, `orders.vat_rate numeric(5,2)` — `total` itself
    was **never touched**, since the 9.1 comment it replaces already
    established `total` as "not a final total," so decomposing it is
    additive by definition, not a redefinition.
    - **SNAPSHOTTED at creation time, confirmed directly over live-derived**
      — same precedent as `order_items.unit_price` (9.1): a sale's VAT rate
      is a historical/compliance fact about THAT sale, not something that
      should silently change if the shop's `vatRegistered`/`defaultVatRate`
      settings change afterward. Set once, in `resolveVatRate(shop)`, called
      only from `createOrder` and 9.7's `syncOfflineOrder` — never touched by
      add-items, discounts, cancel/void, payments, or refunds. Pre-9.8 orders
      have `vat_rate = NULL`, read back as `vatRate: null` /
      `vatExclusiveAmount: null` / `vatAmount: null` — an honest "VAT was
      never calculated for this historical order," not a fabricated 0%.
    - **Proven non-vacuous, the load-bearing property**: temporarily hardcoded
      `createOrder` to always snapshot `0` regardless of the shop's actual
      settings — exactly the 9 tests that depend on a real snapshotted rate
      failed (the non-registered/zero-rate/legacy-order/offline-sync tests
      correctly kept passing, since those all resolve to 0 or read a
      genuinely-stored value anyway). Then reverted. This is the single most
      important guarantee in this submodule: it proves the tests would
      actually catch a regression back to "live" behaviour, not just that
      they pass today.
    - **`total` is VAT-INCLUSIVE (confirmed directly)** — matches how UK
      till/menu prices are actually shown to the customer. `vatAmount` is
      decomposed OUT of the existing `total`, never added on top; nothing a
      customer pays changes. This is why 9.5/9.6's payment math needed zero
      changes: `balanceDue` still keys off `total`, which 9.8 never alters.
    - **`vatAmount` is deliberately the REMAINDER** (`total - vatExclusiveAmount`),
      not an independent `total * rate / 100` — so the two always reconcile
      to `total` EXACTLY, by construction, same "one definition of a total"
      discipline as 9.5's `amountPaid`/9.6's `sumRefundAmounts`. **Empirically
      verified across 8 cases** before being trusted, including a genuine
      repeating decimal (£7.99 at 20% → 6.66 + 1.33 = 7.99) and a 1p edge case
      — every case reconciled exactly, and no division-by-zero risk exists
      since the denominator (`1 + rate/100`) is 1 at its lowest.
    - **A real naming collision caught before shipping**: the natural name for
      the ex-VAT figure, `netAmount`, was ALREADY used by 9.6 inside each
      payment object to mean "still refundable" (net of REFUNDS). Renamed to
      **`vatExclusiveAmount`** so the same word can't mean two different
      things at two nesting levels of the same response.
    - **A shop with `vatRegistered: true` and `defaultVatRate` left unset
      (confirmed directly, a real gap `shop.validation.js` still allows) is
      treated as 0%, not blocked** — order creation must not fail over the
      OWNER's own misconfiguration, which till staff have no way to fix
      mid-sale. `shop.validation.js` was **not touched at all**.
    - **Single shop-level rate applied to the whole order (confirmed
      directly), not a per-item/category override** — matches what the
      schema actually has today (`default_vat_rate` is per-shop, not
      per-menu-item) and the roadmap's own wording. Does not correctly
      handle a shop with genuinely mixed VAT rates in one basket (e.g. hot
      food vs. a zero-rated cold drink) — flagged as a real scope limit,
      not invented beyond what exists.
    - **KNOWN LIMITATION, same shape as 9.7's own**: an offline-synced order
      (9.7) snapshots the shop's CURRENT VAT settings at SYNC time, not at
      the time the sale actually happened (`occurredAt`) — there is no
      history of a shop's past VAT settings to recover the rate that truly
      applied then. Accepted for the identical reason 9.7 accepts not
      knowing a soft-deleted menu item's old state: no versioned settings
      table exists to do better.
    - Reuses the **already-existing** `shopRepository.findActiveShopById`
      (already selects `vat_registered`/`default_vat_rate`) — no new shop
      lookup code, no new repository function needed anywhere in
      `shop.repository.js`.
    - 15 new tests in `orderVat.test.js`: non-registered baseline, registered
      decomposition, a repeating-decimal case, registered-with-no-rate, the
      snapshot proof in both directions (rate raised, rate lowered, dropped
      to non-registered — old order unaffected, new order picks up the
      change), a raw-inserted legacy row reading back as null, interaction
      with a 9.3 order discount and a 9.4 voided item (VAT decomposes the
      FINAL total), cancellation not zeroing the VAT record, an explicit 0%
      rate, offline-sync snapshotting (including a replay after a
      subsequent rate change), and the Server/ACCESS_TILL permission gate.
      Total suite **763 passing**, all 748 pre-existing tests re-run
      **completely unmodified**; `git diff` shows only 15 deleted lines
      across the whole submodule, all of them column-list/comment
      extensions or the pre-existing `total` line replaced by an
      arithmetically identical `roundedTotal` variable — no behaviour
      deletions, no `app.js` touch, no new permission.
- **Module 10 — Kitchen Display System (10.1–10.3, complete):**
  - **10.1** Real-time order push via WebSocket — built on Opus (a judgment
    call, not a roadmap flag: first WebSocket infrastructure in the project,
    a new cross-tenant security boundary, and it touches previously-approved
    auth middleware). New module `src/modules/kds/` (`kdsSocket.js`), new
    dependency **`ws` ^8.21.3** — chosen over `socket.io` because the KDS
    clients are native Android/iOS apps, so socket.io's matching JS client
    (its main advantage) buys nothing, and `ws` has **zero dependencies**
    and plugs straight into the existing raw `http.Server`.
    - **`app.js` was NOT touched at all**, and this is structural rather
      than lucky: a WebSocket upgrade never reaches Express. Node routes a
      request carrying `Upgrade: websocket` exclusively to the
      `http.Server`'s `'upgrade'` listeners and never to the `'request'`
      listener Express is mounted on. So app.js's route table, middleware
      chain, and its load-bearing mount-ordering hazard (Section 2) are all
      simply not in play. `server.js` is where it attaches, in 2 lines.
    - **`GET wss://…/api/shops/:shopId/kds/socket`**, authenticated with the
      SAME `Authorization: Bearer` header as every REST route — deliberately
      not a query-string token: native WS clients (OkHttp/URLSession) can set
      handshake headers, so no new transport convention was invented, and the
      token stays out of any log that captures the request line.
    - **New `VIEW_KDS` permission** (Manager, Shift Manager, Chef by default;
      **Server deliberately not**). Confirmed directly over reusing
      `ACCESS_TILL`: the **Chef is the KDS's primary user and is the one role
      that has never had till access**, so gating the kitchen screen on the
      till permission would lock out exactly who needs it. It is the mirror
      image of the front-of-house/kitchen split, not a duplicate of it.
      `permissions.js`'s existing unit tests needed **zero changes** — they
      assert specific permissions rather than exhaustive lists, the same
      reason 9.3's `APPLY_DISCOUNT` addition needed none.
    - **Auth logic EXTRACTED, not duplicated (confirmed directly)** —
      `requireStaffOrOwnerAuth`'s token→actor body moved verbatim to
      `staffAuth/actorFromToken.js`, with the middleware now a thin wrapper.
      The socket handshake genuinely cannot reuse the middleware (it never
      runs Express), only the logic inside it, and two independent copies of
      security-critical "how do we authenticate somebody" is exactly the pair
      that silently drifts. **Proven behaviour-preserving**: the full suite
      re-run **763/763 completely unmodified** immediately after the
      extraction, before anything was built on top of it. The resolver
      returns **null** for an auth failure but still **throws** for an
      infrastructure failure — so a database outage stays a 500 and never
      degrades into a misleading 401.
    - **Authorization reuses `resolveActorAuthority` + `assertHasPermission`
      unchanged**, so cross-tenant isolation is correct **by construction**:
      that function already rejects any `shopId` that is not a staff member's
      own, and already requires an owner's company to own the shop. No new
      authorization logic was written.
    - **`noServer: true`** rather than handing `ws` the server — that is what
      lets auth run BEFORE the handshake completes, so a refused client gets
      a real **401/403/404** HTTP response (body in the same
      `{ error: { message } }` shape as REST) instead of a socket that opens
      and immediately closes.
    - **Pushes on four events**: `order.created`, `order.items_added`,
      `order.cancelled`, `order.item_voided` — cancel/void included
      (confirmed directly) so the kitchen is told to STOP, which is worth one
      additive line each inside 9.4's two functions. **`broadcastOrderEvent`
      never throws, never rejects, never awaits**: every caller has already
      committed its writes, so a notification failure must not turn a
      recorded order into an error for the till — and with no transaction
      wrapper there would be nothing to roll back anyway.
    - **An offline-synced order (9.7) deliberately does NOT push**, with its
      own test locking the decision in: a sync is a HISTORICAL record of a
      sale that already happened and was already paid, `occurredAt` may be
      days old, and the food was made at the time. Pushing it as new kitchen
      work would be actively wrong.
    - **Both security properties proven non-vacuous** (same discipline as
      9.5/9.6/9.7's decline branches): breaking the shop keying so broadcast
      hit every socket failed **exactly the isolation test and only it**;
      disabling the permission gate failed **exactly the Server-403 test and
      only it**. Both reverted.
    - **A comment of mine was empirically DISPROVED and corrected rather than
      left standing**: `server.js` claimed the KDS sockets must be closed
      before `server.close()` or a live WebSocket would hold the process
      open. Removing that close() and testing with a real connected socket
      showed the process still exits cleanly in ~1s — an upgraded socket is
      detached from the http.Server's tracked connections, so `close()` never
      waits on it. The line is kept (deliberate teardown + clearing the
      heartbeat) but the stated reason is now accurate, and the wrong
      intuition is recorded so it isn't re-derived later.
    - **`server.js` has no test coverage** (tests import `app.js`, never the
      entrypoint), so it was smoke-tested directly against the real process:
      boots, `/health` ok, an unauthenticated upgrade returns **401**, a real
      authenticated KDS socket connects, and SIGTERM exits cleanly in 1s.
    - **KNOWN LIMITATIONS, flagged rather than hidden**: (a) the connection
      registry is **in-memory and per-process** — correct under today's
      single-instance Render deployment (no autoscaling configured), but a
      KDS on instance A would not see an order created via instance B, and
      this project has no pub/sub layer to bridge that; (b) app.js's
      `express-rate-limit` does **not** apply to upgrades (same Express
      reason as above), so the handshake has no 300-per-15-min ceiling in
      front of it — one staff-session DB lookup per attempt, since the
      owner-JWT check short-circuits locally first.
    - 16 new tests in `kdsSocket.test.js` — a new testing shape for this
      project, since **supertest cannot drive a WebSocket upgrade**: each
      test binds a real `http.Server` on an ephemeral port, attaches the
      socket server exactly as `server.js` does, and connects a real `ws`
      client, while REST calls still go through supertest against the same
      `app` (both share one process, so the module-level registry links
      them — the same mechanism production uses). Covers: owner/Chef
      connect, Server 403, missing/garbage token 401, wrong path 404,
      cross-shop staff 404, cross-company owner 404, all four push events,
      **two-shop isolation**, two screens in one shop, offline-sync
      non-push, and registry cleanup on close.
    - **Test-only bug found and fixed while writing them**: `ws.terminate()`
      on a REFUSED (still-CONNECTING) socket emits an **asynchronous**
      `'error'` event, which Node re-throws as an uncaught exception when no
      listener remains — and being async, a `try/catch` around the call
      cannot catch it. Fixed by attaching one permanent no-op `'error'`
      listener at socket creation. It had been masking the real assertion
      results of all six rejection tests.
    - Total suite **779 passing** (763 pre-existing, re-run **completely
      unmodified**, + 16). One unrelated menu test (`shopMenuModifierOverrides`)
      flaked **once** under the extra parallel load and passed on three
      subsequent full runs; proven not to be caused by this work, since the
      suite is **763/763 with identical source** when only the new test FILE
      is removed. Pre-existing, load-related, recorded here rather than
      quietly ignored.
  - **10.2** Item status flow (in progress → ready → served) — built on
    Sonnet (no roadmap flag, and nothing here is structurally novel the way
    10.1 was: it sits entirely on top of already-tested plumbing). New
    columns on `order_items`: `status text NOT NULL DEFAULT 'pending'`,
    `status_updated_at`/`status_updated_by_actor_type`/
    `status_updated_by_actor_id` (same actor-tracking shape as every other
    mutation in this project). New `PATCH
    /api/shops/:shopId/orders/:orderId/items/:orderItemId/status`.
    - **`'pending'` added as the starting state (confirmed directly), beyond
      the roadmap's literal 3-word list** — "in progress → ready → served"
      doesn't name what's true before "in progress", and something has to
      be. Lets a busy kitchen screen distinguish "on the ticket, not started"
      from "actively being made". `ORDER_ITEM_STATUSES` in `orderConstants.js`
      is a plain JS array, same convention as `ORDER_TYPES`/`DISCOUNT_TYPES`;
      the column is plain `text` with no CHECK constraint, so extending the
      list later needs no schema change - the same pattern `orders.status`
      itself already established.
    - **Transitions are UNRESTRICTED (confirmed directly)** — any status may
      be set at any time, forward or backward, with a test proving both a
      backward correction (ready → in_progress) and a direct skip
      (pending → served) are accepted. Deliberately UNLIKE `orders.status`,
      which only ever advances through 9.4/9.5/9.6's one-directional
      business events: an item's prep status is a live operational field a
      kitchen routinely needs to correct in the moment (a mis-tap), with no
      audit/compliance reason to lock it into one direction the way money
      movements are.
    - **New `PATCH` gated on the EXISTING `VIEW_KDS` permission (10.1),
      confirmed directly over introducing a new one** — mirrors 7.7's own
      precedent exactly ("reading and logging share one permission gate...
      overriding the original design"): the Chef is the one role built to
      both watch the kitchen screen and update what's on it, on the same
      device. `permissions.js` was **not touched at all**.
    - **Guarded on the order being cancelled, and on the ITEM being voided
      (both 400) — but deliberately NOT on `order.status === 'open'`**, i.e.
      `requireOpenOrder` (9.4) is NOT reused here, on purpose: a till taking
      payment does not stop the kitchen from cooking, so a `'paid'` order
      must not block its own prep status from advancing, proven by a test
      that pays an order in full and then still successfully advances an
      item's status. Only cancellation blocks it — nothing should still be
      "in progress" once the whole order has been called off.
    - **Response is purely additive**: `status` is a flat string on each
      item (same shape as `order.status` itself, which also carries no
      generic per-change actor field of its own — 9.4/9.5/9.6 each have
      their OWN dedicated actor columns for their own specific transitions
      instead), always present from creation (`'pending'`), never null the
      way `discount`/`void` can be. A dedicated test confirms every
      pre-existing field on an item (`unitPrice`, `lineTotal`, `total`,
      `discount`, `void`) and the order's own `subtotal`/`total` are
      byte-for-byte unaffected by a status change.
    - **Pushes `order.item_status_changed` over 10.1's EXISTING KDS
      channel** — one new `KDS_EVENTS` entry, zero new infrastructure. Same
      best-effort `broadcastOrderEvent` (never throws, never blocks the
      write), proven live end-to-end with a real connected `ws` client
      receiving the pushed event.
    - **Both guards proven non-vacuous** (same discipline as every prior
      submodule's decline/rejection branches): disabling the
      cancelled-order guard failed **exactly that one test and only it**;
      disabling the voided-item guard failed **exactly that one test and
      only it**. Both reverted.
    - **Zero touches to 7.9's deduction engine, deliberately** — the
      roadmap assigns the inventory-deduction trigger to **10.3** on
      purpose, flagged for its own elevated scrutiny; 10.2 only records the
      status, it never calls `deductInventoryForSale`.
    - 15 new tests in `orderItemStatus.test.js`: default `'pending'` with no
      audit fields set, setting a status stamps actor/time, every fixed
      status accepted, an unrecognised value rejected, backward transition,
      skip-ahead transition, cancelled-order 400, **paid-order still
      allowed** (the key non-restriction proof), voided-item 400,
      cross-order scoping 404, non-existent item 404, additive response
      contract, Chef/Server `VIEW_KDS` permission split, and the live KDS
      push. `git diff` shows only **3 deleted lines** across the whole
      submodule — a stale forward-reference comment and one import line
      extended — no behaviour deletions, no `app.js` touch, no new
      permission.
    - **Two full-suite flakes investigated, neither caused by this work**:
      a stalled child process (`inventoryScan.test.js`, unrelated module)
      and a request that returned 400 instead of 201
      (`orderOfflineSync.test.js`, unrelated module, occurredAt-vs-createdAt
      test). Both files pass **100% in isolation** and touch zero code this
      submodule changed; a clean full run afterward was
      **794/794 - 779 pre-existing (completely unmodified) + 15**. Same
      "investigate, don't dismiss" discipline as 10.1's own flake, and the
      same conclusion: load/environment noise under this specific test
      runner, not a regression.
  - **10.3** Per-item inventory deduction trigger — built on **Opus**, per
    the roadmap's own "elevated scrutiny and a stronger model" flag: it
    moves real stock, and its central hazard is a genuine concurrency /
    idempotency problem with no transaction wrapper anywhere to fall back
    on. This is the trigger **7.9 was built for and deliberately shipped
    without** ("nothing user-facing should be able to move stock with no
    sale behind it"). `saleDeduction.service.js` is called **completely
    unchanged** — not one line of 7.9 was touched.
    - **One new NULLABLE column, `order_items.inventory_deducted_at
      timestamptz`** — no new table, no new endpoint, no new permission, and
      **`app.js` was not touched at all**, so there was no route-mounting
      risk of the kind that bit 7.7. The nullability IS the regression
      strategy, the same reasoning as 9.7's `client_order_id` and 9.8's
      `vat_rate`: every pre-existing order item reads back as NULL, so
      Modules 7/9 are unaffected **by construction rather than by
      remembering to re-test**.
    - **Trigger status: `ready` (confirmed directly)** — the moment the
      kitchen declares the item made. **`served` is included as a BACKSTOP,
      not a second trigger**: 10.2 deliberately allows unrestricted
      transitions and has its own test for a direct `pending → served`
      jump, so a real sale could otherwise skip straight past `ready` and
      **never deduct at all** — a silent under-deduction in a flow 10.2
      explicitly supports. `pending`/`in_progress` deliberately do not
      deduct: prep can be abandoned or the line voided mid-cook.
    - **IDEMPOTENCY IS THE WHOLE PROBLEM, and it is delegated to Postgres
      rather than implemented in JS.** Because transitions are unrestricted,
      an item can re-enter a deducting status any number of times (a mis-tap
      corrected back to `in_progress` then set to `ready` again; `ready`
      then `served`; two KDS screens in one shop tapping at the same
      instant, which 10.1 explicitly supports and tests). Stock may move
      **once, ever**. A single-statement atomic claim does it:
      `UPDATE order_items SET inventory_deducted_at = now() WHERE id = $1
      AND inventory_deducted_at IS NULL RETURNING …` — the caller deducts
      **if and only if** a row comes back.
    - **EMPIRICALLY VERIFIED before any code was written around it**, same
      discipline as 7.9's `unnest()` finding and 9.7's `ON CONFLICT`
      finding, because a silent double-deduction is exactly that class of
      bug: (a) sequential — first call returns 1 row, second returns 0, and
      the original timestamp is **preserved, not overwritten**; (b)
      genuinely **CONCURRENT** (two overlapping transactions on separate
      connections) — the second **BLOCKS** on the first's row lock, then
      under READ COMMITTED **re-evaluates the WHERE against the newly
      committed row**, finds the column no longer NULL, and returns **0
      rows**. Exactly one winner, confirmed in **both orderings**; (c) a
      rolled-back claim correctly **releases**, leaving the column NULL.
    - **THE CLAIM COMES FIRST, and that ordering is load-bearing.** Reading
      a flag and writing it *after* the deduction would let two concurrent
      callers both read NULL and both deduct. Claim-then-deduct means only
      the winner proceeds.
    - **NOT best-effort, deliberately UNLIKE `broadcastOrderEvent`.** A KDS
      push is a notification and must never fail a recorded order; a stock
      movement is real business data, so a genuine database failure surfaces
      as a 500 rather than being swallowed. This can only ever be an
      INFRASTRUCTURE failure — `deductInventoryForSale` never throws for a
      business reason (an unlinked ingredient is reported in `skipped` and
      never blocks the rest of the sale, proven by a test asserting the
      status update still returns 200 and the *linked* ingredient still
      deducted).
    - **Runs AFTER the status write** — advancing the prep status is the
      kitchen's actual request and must not be held hostage to inventory,
      and this leaves 10.2's already-approved write in the exact position it
      shipped in. 10.2's voided-item guard also means a voided line can
      never reach the deduction at all.
    - **Response contract is UNCHANGED — no new fields at all.** The route
      is `VIEW_KDS`-gated and ingredient/inventory detail belongs to
      `VIEW_INVENTORY`, the same separation **8.2** made in keeping
      `quantityOnHand` out of the scan response. `skipped` goes to a
      `logger.warn` for ops visibility, never to the caller. A test asserts
      no `inventoryDeductedAt`/`deducted`/`skipped` key leaks and that every
      pre-existing item/order field is untouched.
    - **No auto-reversal on void or cancel (confirmed, same philosophy as
      8.4/9.4)** — two tests lock this in: voiding an already-deducted item,
      and cancelling an order after a deduction, both leave stock exactly
      where the deduction left it. The ingredients really were used;
      correcting a genuine mistake goes through 7.1's manual `PATCH
      quantityOnHand` or a 7.7 wastage entry, as everywhere else.
    - **All three properties proven NON-VACUOUS** (the discipline every
      prior submodule used): removing `AND inventory_deducted_at IS NULL`
      failed **exactly the three idempotency tests and only those** —
      including the two-concurrent-requests one, proving that test is real;
      removing `'served'` from `INVENTORY_DEDUCTION_STATUSES` failed
      **exactly the skip-ahead test and only it**; disabling the trigger
      call entirely failed **14 tests, with exactly the 5 that assert *no*
      deduction still passing**. All reverted.
    - **KNOWN LIMITATION, deliberately accepted and flagged rather than
      hidden**, the same shape as 9.5/9.6/9.7's: the claim and the stock
      write are separate statements, not one transaction (this project has
      no wrapper anywhere and 10.3 adds none). If the claim commits and the
      connection then dies before the stock write, that line is permanently
      marked deducted without its stock having moved — a one-off
      **UNDER**-deduction, correctable via 7.1's manual PATCH. The claim is
      deliberately **NOT released** in that case: releasing it would trade
      this narrow failure for the risk of a silent **DOUBLE**-deduction
      whenever a write actually committed but its acknowledgement was lost,
      and a compensating write is precisely what this project avoids without
      a transaction to make it safe (see 9.5's charge ordering).
    - A second accepted consequence of 10.2's unrestricted transitions: a
      **mis-tap onto `ready` fires a real, non-reversible deduction**.
      Flagged rather than engineered around — restricting transitions would
      undo 10.2's own confirmed design.
    - 19 new tests in `orderInventoryDeduction.test.js`: the core trigger,
      quantity multiplication, pre-`ready` statuses deducting nothing, the
      three idempotency cases (re-entry after correction with the original
      claim timestamp preserved, `ready`→`served`, two genuinely concurrent
      requests), the `served` skip-ahead backstop, sibling items untouched,
      the shop-local menu item path, an unlinked ingredient skipped without
      failing the request, an item with no recipe, insufficient stock going
      negative rather than blocking, no reversal on void or cancel, the
      cancelled-order guard deducting nothing, the unchanged response
      contract, Chef-succeeds/Server-403, and payment moving no stock (10.3
      owns the trigger, not 9.5). Total suite **813 passing**, all 794
      pre-existing tests re-run **completely unmodified**; `git diff` shows
      **170 insertions and 1 deletion**, that deletion being an import line
      expanded to multi-line — no behaviour deletions, no `app.js` touch, no
      new permission, no change to 7.9.
- **Post-10.3 security hardening (from a full-codebase audit).** Two
  findings in already-shipped 10.1/10.2 code, both fixed and both proven
  non-vacuous:
  - **The KDS was leaking `ACCESS_TILL`-gated data through the `VIEW_KDS`
    gate.** Every socket push, and 10.2's item-status HTTP response, carried
    the FULL order detail — the payment ledger (method, amounts,
    tendered/change, provider reference), discounts, VAT breakdown and
    running balance. The Chef is the KDS's primary user and is deliberately
    the one role WITHOUT till access, so `GET /orders/:id` 403s them while
    these two paths handed over the same data anyway. Fixed by
    **`kds/kdsOrderView.js`**, an ALLOW-LIST projection (`toKdsOrderView`)
    that keeps what a kitchen needs — items, quantities, variant/modifier
    names, prep status, void/cancel state, table and customer name — and
    drops every monetary field at all three nesting levels. Being an
    allow-list rather than a delete-list, a money field added to
    `toDetailResponse` by a future submodule is excluded automatically
    instead of leaking until someone remembers to strip it. Exactly the
    separation **8.2** already made in keeping `quantityOnHand` out of the
    `PERFORM_HEALTH_SAFETY` scan response.
    - Applied **inside `broadcastOrderEvent`**, not at its five call sites —
      same "correct by construction" reasoning as keying the registry by
      shop: a projection at the call sites is one forgotten line away from
      leaking again the next time an event is added.
    - **BREAKING for the Android/iOS KDS clients** — they must not rely on
      any removed field. Flagged rather than hidden.
    - **Two previously-approved tests were rewritten**, deliberately: they
      asserted the old full-detail response (`unitPrice`/`subtotal`/`total`
      unchanged), which WAS the leak rather than the contract. They now
      assert the two properties that matter — the kitchen still gets what it
      needs, and none of the money comes with it.
  - **KDS sockets never re-checked authorization after the handshake.**
    Every REST request re-resolves its actor, so deactivating staff takes
    effect on the next call — but a socket has no next call, so a
    deactivated employee's tablet kept streaming live orders indefinitely,
    held open by the heartbeat. `revalidateConnections` now re-runs the full
    check on the existing 30s heartbeat. It re-resolves **from the token**,
    not just via `resolveActorAuthority` on the handshake actor — that
    distinction is the point, since `resolveActorAuthority` trusts the role
    and shopId already on the actor object and would NOT notice a
    deactivation. Going through `resolveActorFromToken` catches all five
    revocation paths: deactivation, logout, session expiry, role change, and
    a withdrawn override. **Fails CLOSED on an auth failure, OPEN on an
    infrastructure one** — treating a database blip as revocation would
    disconnect every KDS in every shop, turning a brief outage into an
    estate-wide kitchen blackout.
    - **Deliberate side effect**: `resolveActorFromToken` touches
      `last_active_at`, so a connected KDS keeps its staff session alive on
      the sliding 60-minute window. Taken this way round because a screen
      that dies hourly mid-service is a worse failure than a session
      outliving an idle shift.
  - Both proven non-vacuous: un-narrowing the broadcast failed **exactly the
    money test and only it**; disabling re-auth failed **exactly the two
    revocation tests** while the "still-authorized socket survives" test kept
    passing — proving the sweep isn't simply closing everything. 4 new tests
    in `kdsSocket.test.js`, 1 new in `orderItemStatus.test.js`. Suite **818**.
- **Order numbers + derived kitchen status (KDS scope clarification).**
  Confirmed directly: the KDS shows an order NUMBER and its items, never
  prices; the Chef updates status per ITEM and the screen rolls those up to a
  ticket-level state.
  - **`orders` had no human-readable identifier at all** — only a UUID, which
    is unusable on a wall-mounted screen. New `shop_order_counters`
    (`shop_id`, `business_date`, `last_number`) plus nullable
    `orders.order_number` / `orders.order_date`, exposed as `orderNumber` /
    `orderDate` on the list, detail and KDS responses. Nullable is the
    regression strategy again (9.7/9.8/10.3): pre-existing orders read back
    `null` rather than a fabricated number.
  - **A counter table, not a Postgres sequence** — a sequence can't reset per
    shop per day without DDL, and is non-transactional by design, so a
    rolled-back insert would burn a number and leave visible gaps in what
    staff read as a contiguous daily count.
  - **Allocation is ONE atomic statement** — `INSERT ... ON CONFLICT
    (shop_id, business_date) DO UPDATE SET last_number = last_number + 1
    RETURNING`. `SELECT max()+1` would hand two simultaneous tills the SAME
    number, and this project has no transaction wrapper to make read-then-
    write safe. **Verified empirically before any code was written against
    it** (same discipline as 10.3's claim / 9.7's ON CONFLICT): 50 genuinely
    concurrent allocations returned 50 DISTINCT contiguous numbers, a second
    date restarted at 1, a second shop kept its own sequence. **Proven
    non-vacuous**: swapping in `SELECT max()+1` fails **exactly the
    concurrency test and only it** — the six sequential tests still pass,
    which is correct, since `max()+1` only breaks under a genuine race.
  - **Allocated after all validation, immediately before the insert**, so a
    rejected order never consumes a number. **9.7's replay path pre-checks
    `findOrderByClientOrderId` BEFORE allocating**, so a till retrying a
    queued sale doesn't burn a fresh number per retry and tear gaps through
    the day; the post-insert duplicate handling stays as the race fallback.
    A synced order is numbered against its `occurredAt` day, not its sync
    day. Burned numbers are possible only if an insert fails after
    allocation — a gap, never a duplicate, which is the safe direction.
  - **KNOWN LIMITATION, flagged not hidden**: there is no per-shop timezone
    column anywhere in this schema, so "day" means **UTC** (following 8.4's
    `todayUtcDateString` precedent, so every date-keyed feature agrees). A
    late-night venue therefore resets numbering at midnight UTC — 2am during
    BST — rather than at close of trade. Fixing it properly needs either a
    `shops.timezone` column or a configurable business-day cutoff; inventing
    one would be guessing at a policy nobody has set.
  - **`kitchenStatus`** — derived, never stored ("derive, don't store"): the
    LOWEST item status across non-voided lines, so a ticket only reads
    `ready` once EVERY line is, and voided lines can't hold it back.
    **Named `kitchenStatus`, not `status`**, because `order.status` already
    means the payment/business state — the same collision 9.8 avoided by
    renaming its ex-VAT figure to `vatExclusiveAmount`. Imports
    `ORDER_ITEM_STATUSES` for the progression order rather than keeping a
    second copy that could drift. **Proven non-vacuous**: inverting the rule
    to take the highest status failed exactly the three tests that depend on
    it.
  - `in_progress` was deliberately NOT renamed to "preparing" (confirmed
    directly) — the shipped constant stands.
  - 7 new tests in `orderNumbering.test.js`, 6 in `orderItemStatus.test.js`,
    1 in `kdsSocket.test.js`. Suite **832**. The concurrency test uses 8
    parallel requests, deliberately not more: the pg pool's default max is
    10, and over-subscribing it while ~70 other test files run would trip the
    newly-added `connectionTimeoutMillis`. Confirmed still non-vacuous at 8.

### Remaining

#### Module 11 — Loyalty/Rewards Program
- **11.1** Program config (points vs stamp-card, toggleable)
- **11.2** Customer lookup/record (phone number based)
- **11.3** Earning/redemption logic
- **11.4** Chain-wide shared points

#### Module 12 — Reporting
- **12.1** Sales reports
- **12.2** Purchase & wastage reports
- **12.3** Best/least-selling items
- **12.4** Custom date-range filtering
- **12.5** PDF export
- **12.6** Chain consolidated view + per-shop breakdowns

#### Module 13 — Real Payment Provider Integration (later, once vendor decided)
- **13.1** Vendor SDK integration behind existing PaymentProvider interface
- **13.2** Merchant account model decision (direct vs Stripe Connect)
  implementation

---

## 5. Known Issues / Environment Notes

- `.env.example` is committed and HAS carried real-format secrets (Stripe
  key, Resend key, JWT access secret, local DB password) since commit
  `a5a3834`. **Nabil is rotating these at the providers**; editing the file
  does not undo the exposure, only rotation does. Once rotation is
  confirmed, replace the values with obvious placeholders. Decision taken:
  **no git-history rewrite** — once rotated the old values are worthless and
  rewriting a pushed history costs more than it buys. A dead
  `JWT_REFRESH_SECRET` entry was removed (refresh tokens are opaque and
  server-side, never JWTs, so no such secret exists).
- **`app.set('trust proxy', 1)` is load-bearing and the value must never
  become `true`.** Render terminates TLS and proxies to the app, so without
  it `req.ip` is the PROXY's address for every request — which silently
  turned the global 300-per-15-min limiter into a cap for the ENTIRE
  platform rather than per client, and collapsed the staff-login limiter to
  per-shop-globally. `true` would be worse than the bug: it trusts the whole
  `X-Forwarded-For` chain, making its client-supplied leftmost entry
  authoritative, so anyone could spoof an IP per request and defeat rate
  limiting outright. Verified empirically: with `1`, a forged
  `"1.2.3.4, 203.0.113.9"` chain resolves to `203.0.113.9`; with `true` the
  same header resolves to the attacker's `1.2.3.4`. `1` matches
  render.yaml's single `type: web` service; add a CDN and it becomes 2, and
  under-counting degrades safely (falls back to the CDN's IP) while
  over-counting opens the hole.
- **`pg` defaults `connectionTimeoutMillis` to 0 — wait FOREVER.** This is
  why pool starvation has shown up in this project as a test file hanging
  for 20+ minutes (recorded as "environment noise" in 10.1/10.2) rather than
  as an error. Now set to 10s, with a 30s `statement_timeout`. `max` is
  deliberately left at pg's default of 10: production runs a SINGLE Render
  instance (one process, one pool), so the 10-connection ceiling only ever
  bit the TEST harness, where ~8 parallel `node --test` processes each open
  their own pool of 10 against a `max_connections` of 100.
- `render.yaml` declared only 3 env vars while `src/config/env.js`'s
  `requiredVars` demands 11, so a Blueprint deploy crash-looped at
  `validateEnv()`. All 8 missing ones are now declared `sync: false` (Render
  prompts and stores them in the dashboard — no secret enters the repo).
  Its `branch:` also said `main` while the repo's only branch is `master`.
  **These are declarations only — the values must still be set by hand in
  the Render dashboard for any already-existing service.**
- `cross-env` (v10.1.0) is required for Windows compatibility in `package.json`
  scripts — use `npm run migrate:up:dev` / `migrate:down:dev` for local dev.
- Staff-login rate limiter (`src/modules/staffAuth/staffAuth.routes.js`) is
  keyed by `(IP, shopId)`, not IP alone — deliberately fixed this way so
  unrelated shops sharing a NAT/corporate egress IP (or, in testing, many
  independent test files each creating their own shop) don't exhaust each
  other's quota. This only actually works because of `trust proxy` above.
- `attachRelationship` / `detachRelationship` / `adjustInventoryQuantities` and
  similar generic SQL helpers take table/column names as hardcoded string
  literals from trusted internal code, never user input — not a SQL injection
  risk, same trust boundary as every `COLUMNS` constant in this codebase.

---

## 6. Key File Structure

src/app.js — route mounting (order is load-bearing, see Section 2)
src/config/, src/db/migrations/
src/middleware/ — requireAuth, requireStaffAuth, requireStaffOrOwnerAuth, validate, errorHandler
src/modules/
auth/, billing/, company/, shop/, staff/, staffAuth/, rota/
menu/ — master + shop-level menu, recipe linking (7.2)
inventory/ — items, low-stock, supplier linking, shared bulk helpers,
             cross-shop overview (7.8), ingredient↔item links + the
             sale deduction engine (7.9, saleDeduction.service.js — no route;
             its ONE caller is 10.2's item-status endpoint via 10.3's
             trigger, which imports it unchanged)
suppliers/ — supplier CRUD (7.4)
purchaseOrders/ — PO logging (7.5) + receiving (7.6)
wastage/ — wastage logging (7.7)
healthSafety/ — inventory scan → expiry calculation (8.2, inventory-scans,
                immutable log, PERFORM_HEALTH_SAFETY-gated)
orders/ — order creation + add-items-to-open-order + discounts +
          cancellation/void + payments + refunds + offline sync + VAT +
          item status flow (9.1-9.8 + 10.2, orders + order_items +
          order_item_modifiers + order_payments + order_refunds,
          ACCESS_TILL-gated except the discount routes (9.3) and the refund
          route (9.6) which are APPLY_DISCOUNT-gated, and the item-status
          route (10.2) which is VIEW_KDS-gated; reuses shopMenu's
          getResolvedMenu for pricing rather than re-deriving it;
          paymentProvider.js is the vendor-agnostic seam Module 13 fills in,
          carrying both chargeCard (9.5) and refundCard (9.6); 9.7's
          POST /orders/sync is the one path that does NOT re-derive pricing -
          it trusts the till's snapshotted prices as historical fact and
          dedups on the client's own id via a partial unique index; 9.8's
          vat_rate is SNAPSHOTTED on the order at creation/sync time via
          resolveVatRate, same "historical fact, not derive-don't-store"
          precedent as unit_price - total stays VAT-inclusive and unchanged,
          vatAmount/vatExclusiveAmount only decompose it; 10.2's
          order_items.status has UNRESTRICTED transitions, deliberately
          unlike orders.status's one-directional business events, and pushes
          to 10.1's existing KDS channel rather than adding a new one;
          10.3 hangs the INVENTORY DEDUCTION TRIGGER off that same status
          route - reaching 'ready' (or 'served', the skip-ahead backstop)
          calls 7.9's deductInventoryForSale, exactly once per line ever,
          guarded by an ATOMIC CLAIM on order_items.inventory_deducted_at
          (UPDATE ... WHERE ... IS NULL RETURNING, verified empirically
          under real concurrency). That claim is what makes 10.2's
          unrestricted re-entry safe. Deliberately NOT best-effort like the
          KDS push - a stock movement is real business data - and it adds
          NO response field, since inventory detail stays behind
          VIEW_INVENTORY)
kds/ — kdsSocket.js (10.1): the WebSocket surface for the kitchen display.
       Attached to the http.Server in server.js, NOT mounted in app.js -
       an upgrade never reaches Express, so app.js is untouched by it.
       VIEW_KDS-gated, in-memory shopId -> Set<WebSocket> registry, and
       exports broadcastOrderEvent() which order.service.js calls
       (best-effort, never throws) on create/add-items/cancel/void/
       item-status-change (10.2 reuses this one channel, no new plumbing).
       Also re-authorizes every live socket on the 30s heartbeat
       (revalidateConnections) - fails CLOSED on revoked auth, OPEN on an
       infrastructure error, so a DB blip can't blackout every kitchen.
   kdsOrderView.js: the ALLOW-LIST projection every KDS payload passes
       through (applied inside broadcastOrderEvent, and as the return of
       10.2's VIEW_KDS-gated status route). Keeps what a kitchen needs,
       strips every monetary field - ACCESS_TILL data must not reach the
       wider VIEW_KDS gate. Same principle as 8.2's scan response.
src/utils/ — AppError, asyncHandler, sql.js (buildUpdateSet + generic relationship/bulk helpers), jwt, logger, mailer, stripe, token
staffAuth/actorFromToken.js — the ONE definition of "bearer token -> actor"
       (owner JWT, then staff session), shared by requireStaffOrOwnerAuth
       and the KDS handshake. Returns null on an auth failure but THROWS on
       an infrastructure failure, so a DB outage stays a 500 not a 401.
tests/integration/, tests/unit/


---

## 7. Tools & Resources

Node.js (ES modules), Express 4, PostgreSQL via `pg` + `node-pg-migrate`, `zod`,
`bcrypt`, `jsonwebtoken`, `pino`, `stripe`, `resend`, `ws`, `node:test` +
`supertest`, Render / Vercel / GitHub Actions.
# CLAUDE.md — EzPOS Frontend Agent Instructions

This file is the source of truth for how Claude should work on this repo. Read this
and `docs/API_REFERENCE.md` fresh at the start of every session — don't rely on chat
memory of prior sessions to reflect current repo state; verify against the actual
code on disk.

---

## 1. Project Overview

**EzPOS** is a multi-tenant SaaS POS for restaurants and retail, owned and developed
solely by Nabil. This repo is the **web frontend**.

**Stack:** Next.js (App Router), TypeScript, Tailwind CSS, TanStack Query (server
state), `zod` (form + response validation, mirroring the backend's schemas), React
Hook Form.

**Backend:** `https://github.com/md-motiur-rahman/ezpos_api.git` — Node.js/Express 4,
raw SQL via `pg`, PostgreSQL on Render (Frankfurt). **Complete through Module 10**:
owner auth, Stripe billing, company/shop management, staff & permissions, rota, menu,
inventory, health & safety, orders/till/payments/refunds/VAT, and a KDS WebSocket.
~161 REST endpoints plus one socket, all catalogued in `docs/API_REFERENCE.md`.

**Infra:** Vercel (this app), Render (API + managed PostgreSQL), GitHub Actions.

**The backend is frozen from this repo's point of view.** This project does not
change the API. If something genuinely cannot be built without an API change, say so
explicitly and stop — do not work around it by re-deriving business rules on the
client.

---

## 2. Architecture Fundamentals

These are consequences of how the API actually behaves. Getting any of them wrong
produces bugs that look like backend bugs.

- **Two auth systems, never mixed.** Owner: JWT access token (**15 min**) plus an
  opaque **rotating** refresh token. Staff: opaque DB session token, **sliding
  60-min** window, **no refresh endpoint** — on expiry the user re-enters their PIN.
  Both ride the same `Authorization: Bearer` header, which is exactly why they need
  **separate storage keys and separate contexts**. One shared "token" slot will
  eventually send a staff token to an owner-only route, and the 401 is confusing
  because both look identical on the wire.
- **Refresh must be serialized.** Rotation invalidates the token you sent, so two
  concurrent refreshes guarantee one failure and can log the user out. One in-flight
  refresh promise that all queued 401s await — not one per request.
- **The owner bypasses the permission system entirely.** Every permission check in
  the API applies to staff actors only. UI gating branches on **actor type first**,
  then permission — gating on permission alone gives the owner a crippled UI.
- **Permission-gated UI is a mirror, never the enforcement.** Effective set is
  `role defaults ∪ active overrides` (overrides are additive only — there is no
  deny-list). Use it to hide/disable controls; the server is the authority and a 403
  must still render gracefully.
- **404 is the tenancy boundary.** Anything outside the actor's company or shop
  returns 404, not 403. Never render "this was deleted" on a 404 — render "not found
  or you don't have access".
- **"Explicit null clears, omitted leaves untouched."** This governs every nullable
  field in the API (`lowStockThreshold`, `shelfLifeDays`, `shelfLifeOpenedDays`,
  `sku`, both discount fields). A PATCH form must distinguish three states:
  **untouched** (omit the key), **cleared** (send `null`), **set** (send the value).
  An empty string or `undefined` is not a clear. Build **one** shared form helper for
  this and use it everywhere — this is the single most likely source of silent data
  bugs in this app. For discounts, `discountType` and `discountValue` must be null
  **together**.
- **Never re-derive money on the client.** The API is the one definition of every
  total and they reconcile exactly by construction. Render what it returns; never sum
  `items` yourself, never re-round, never compute a third amount from two others the
  API already provides.
  - `total` is **VAT-INCLUSIVE**. `vatAmount` is decomposed *out of* it, never added
    on top.
  - `vatRate: null` means "this order predates VAT calculation" — render as "not
    calculated", **never as 0%**. `0` is a real and different value.
  - `amountPaid` is **gross**; `netAmountPaid` nets off refunds; `balanceDue` uses
    the net.
  - `payment.netAmount` = still refundable against that payment.
    `order.vatExclusiveAmount` = net of VAT. Two different things, deliberately two
    names — do not conflate them in a shared formatter.
  - `lineTotal` is pre-discount; `item.total` is post-discount.
  - Voided items stay in `items` for audit but are excluded from every total —
    render struck through.
- **`date` columns are calendar strings, not instants.** `orderDate` and `expiresOn`
  are `YYYY-MM-DD`. Running them through `new Date(...).toISOString()` shifts them a
  day for negative-offset users. **Render date strings as strings.** Only
  `createdAt`/`updatedAt`/`occurredAt`/`scannedAt` are real instants and may be
  localized. This exact trap already bit the backend once (its 8.2).
- **"Today" is UTC throughout the API** — there is no per-shop timezone column.
  Order numbering resets at midnight UTC, not at close of trade. Don't localize it
  and imply otherwise.
- **The order state machine drives the till UI.**
  `open → partially_paid → paid → partially_refunded → refunded`, or
  `open → cancelled`. **The first payment locks the order** — add-items, both
  discount routes, cancel and void all stop being accepted the moment status leaves
  `open`. Disable those controls off `status === 'open'` rather than letting the user
  discover it via a 400. **Item prep status is the exception**: it works on a *paid*
  order (payment doesn't stop the kitchen), blocked only by a cancelled order or a
  voided item. Once any refund is issued the order accepts **no further payment**,
  ever.
- **Irreversible actions need confirmation, because the API has no reversal
  mechanism anywhere by design.** Setting a KDS item to `ready`/`served` **deducts
  real inventory**, exactly once, and nothing puts it back — not voiding the line,
  not cancelling the order. Cancel, void, payment, refund, stock receiving, wastage,
  scan resolution and label print are all immutable records. **A staff PIN is
  revealed exactly once**, in the 201 from staff creation, and is never retrievable
  again.
- **Item `source` determines the id field.** The resolved menu tags each item
  `source: "master" | "local"`. Master items order as `menuItemId`, local ones as
  `shopMenuItemId` — **exactly one, never both**. Carry `source` through the cart
  model rather than guessing at checkout.
- **Modifier min/max is enforced server-side — mirror it in the cart.** Every group
  attached to an ordered item is validated against its own
  `minSelections`/`maxSelections`, **including groups the customer never touched**
  (0 selections fails a `minSelections > 0` group).
- **Pricing shape and recipe shape are deliberately opposite.** Pricing: a variant
  price is **absolute** and *replaces* the item price; modifier `priceDelta`s are
  **additive** (and may be negative). Recipes: item + variant + modifier quantities
  all **sum additively** — a variant recipe lists only the *extra* over the base.
  Don't let one intuition leak into the other screen.
- **Error rendering branches on status, never on the message string.** Every error is
  `{ error: { message } }`, and validation failures arrive as one joined string
  (`"Invalid request body - items.0.quantity: …; type: …"`). Never surface that raw.
  400 → "check the highlighted fields" (client-side zod supplies field detail),
  401 → refresh-then-retry-once, 402 → see below, 403 → "you don't have permission",
  404 → "not found or no access", 409 → conflict-specific copy, 429 → "too many
  attempts", 500 → generic.
- **402 is overloaded and must be disambiguated by route.** On `POST /api/shops` and
  `POST /api/shops/:shopId/addons` it means **billing locked**. On a payment or
  refund it means **the card was declined**. Same status, completely different UI.
- **Billing lock is derived, not returned.** There is no `isBillingLocked` flag —
  derive the banner from `subscriptionStatus` + `gracePeriodEndsAt`. When locked,
  **only** shop creation and add-on activation 402; viewing, editing and closing
  shops, and billing history, stay open **on purpose** so the owner can see and
  reduce their bill. Do not blanket the app behind a lock screen.
- **Mirror the backend's constants, don't invent parallel ones.** `ROLES`,
  `PERMISSIONS`, `ROLE_RANK`, `ROLE_DEFAULT_PERMISSIONS`, `ORDER_TYPES`,
  `ORDER_STATUSES`, `ORDER_ITEM_STATUSES`, `DISCOUNT_TYPES`, `PAYMENT_METHODS`,
  `WASTAGE_REASONS`, `SCAN_STATES`, `ALLERGENS`, `ADDON_TYPES` all have exact values
  in `API_REFERENCE.md`. Copy them verbatim into **one** file and derive every UI
  label from it, so a backend addition is a one-file change here.
- **Loading, empty, error, 403 and 404 states are part of "done".** Every list screen
  has non-happy states the API genuinely produces: empty (a new shop has no items),
  forbidden (a Server opening an inventory screen), out-of-scope. A screen without
  them is not finished.
- **Required email landing routes.** The API mails links built from its
  `FRONTEND_URL`. This app **must** serve `/verify-email?token=`,
  `/reset-password?token=`, `/confirm-email-change?token=` and `/billing`. Hard
  dependency, not a nice-to-have.

---

## 3. Design Reference — the screenshots are the spec

Nabil has design screenshots. They live **committed in this repo** so every session
can look at them without them being re-pasted into chat.

```
design/
  README.md                     what's here, what is NOT yet designed
  tokens.md                     derived design tokens (Module 0.3)
  screens/
    01-login.png
    21-shop-detail.png
    31-staff-create-pin-reveal.png
    ...
```

- **Naming: `<order>-<route-slug>[-<state>].png`**, so a screen maps onto its route
  both directions. Suffix genuine variants as separate files — `-empty`, `-loading`,
  `-error`, `-403`, `-mobile`. If a screenshot exists for a state, build that state.
- **Claude reads these directly with the Read tool** — a `.png`/`.jpg` is presented
  visually. The correct move when building a screen is to **read its screenshot
  first, then write the component**. Never build from a prose description of a
  screenshot when the file is on disk.
- **The first pass is tokens, not screens** (Module 0.3). One sweep across all
  screenshots produces `design/tokens.md` — palette with semantic roles, type scale,
  spacing, radii, shadows, and the recurring components (button variants, input,
  card, table row, modal, toast, status pill) — encoded in the Tailwind config
  **once**. Skipping it produces twelve slightly different greys and eight button
  styles, which is expensive to unpick and very hard to see coming.
- **Inconsistencies between screenshots get surfaced, not silently resolved.**
  Designs drift as they're drawn. A conflict is exactly the kind of consequential
  decision Section 4 says to raise before writing code.
- **Map every visible field to its endpoint in the plan, before building.** Flag
  anything on the mockup the API does not return. That gap is real and worth catching
  early: the designs may show reporting charts, loyalty, a customer record, an
  `isBillingLocked` flag, or per-item VAT rates — none of which exist.
  **Never invent an endpoint, and never fabricate a plausible number to fill a
  designed slot.** Name what's missing and stop on that element.
- **Screenshots are layout, hierarchy and content — not a pixel-diff target.** Where
  a screenshot conflicts with a rule in Section 2 (a control that should be disabled
  by permission or order status, a total recomputed client-side, a `null` VAT rate
  drawn as "0%"), **Section 2 wins and the conflict gets flagged.** The designs were
  drawn against an idea of the API, not the one that exists.
- **A built screen is verified by rendering it**, screenshotting it, and comparing
  side by side against the design before it's called done.
- **If a screen has no design**, say so and either ask for one or propose a layout
  consistent with `tokens.md` and the nearest designed screen — flagged as invented,
  not presented as designed.

---

## 4. Interaction Protocol

**Nabil drives this by submodule number.** He says **"proceed 1.1"** (or "plan 6.2",
or just "1.1") and that names an entry in the Section 5 roadmap. Claude works that
submodule and only that submodule.

**Default: two-turn protocol.**
1. Nabil names a submodule → Claude presents a **plan only** (scope, screens, routes,
   API endpoints consumed, components, state, permission gating, which screenshots
   apply, open decisions, model recommendation) and stops.
2. Nabil gives feedback (still no code) or says "proceed" → only then implement.

**Relaxed mode (authorized for well-understood, incremental work):** Nabil may say
"plan and code at the same time." When granted:
- Claude may combine planning and implementation into one turn.
- Claude must still surface genuine design ambiguity as an explicit question
  **before** writing code — never assume on a consequential decision (what a screen
  is allowed to mutate, which permission gates a control, how an irreversible action
  is confirmed, a conflict between the design and Section 2). "Plan and code
  together" means skip the *procedural* back-and-forth, not skip asking about real
  unknowns.
- When in doubt whether something is "genuinely ambiguous" vs. "confidently inferred
  from established precedent", **lean toward asking** — a wrong consequential
  decision costs more than one extra question.

**Code delivery rules (non-negotiable, inherited from the backend where each was
learned the hard way — do not relax):**
- **Every file is delivered in full, every time — never a diff, never a prose
  description of what changed, never "add this line here."** Each violation of this
  on the backend produced a real, time-consuming bug.
- Before delivering any file as final, **re-read it fresh from disk in the same
  turn** — don't trust earlier context to still reflect current state, especially
  after multiple edits.
- When several files change together (a component plus its hook plus its types,
  a refactor spanning screens), deliver all of them together in one response.
- **Code is evaluated (run, rendered, typechecked) before being called done**, not
  just written and assumed correct.
- Reusable utilities are written once and reused, never duplicated per screen.
- Avoid multi-turn "continue" patterns — completeness in one response is the goal.

**Verification discipline:**
- **Verify a response shape against the real running API before building UI around
  it.** `API_REFERENCE.md` is accurate as of backend Module 10, but the server is the
  authority. Hit the endpoint; don't infer from a type someone wrote.
- After any change, run the full check set (typecheck, lint, build, tests) for
  everything plausibly affected — not just the file touched directly.
- Prefer real diagnostic data (actual response bodies, actual status codes, actual
  file contents read fresh from disk) over a second or third theory. **If a fix
  doesn't change the observed symptom, say so plainly** rather than offering another
  guess — go get real data instead.
- **Prove a guard is non-vacuous.** When a submodule adds a rule (a disabled control,
  a permission gate, a validation), temporarily break it and confirm that *exactly*
  the intended test/behaviour fails and nothing else — then revert. This is the
  single highest-value habit carried over from the backend.
- **Flag known limitations rather than hiding them.** The backend's habit of writing
  down accepted trade-offs is why they're all still known.

**Recording a finished submodule — this is what makes this file valuable.**
When a submodule is done, **move its entry from "Remaining" to "Complete" in Section
5 and write it up in the same style as the backend's `CLAUDE.md`**: what was
confirmed directly (and what it was chosen *over*), what was proven non-vacuous, what
was deliberately NOT done, known limitations, and any empirical finding that would
otherwise be re-derived later. A one-line "done" is not an entry.

---

## 5. Module Roadmap

Nothing is built yet. Every entry is under **Remaining**; each gets rewritten into
**Complete** as it ships, per Section 4.

### Complete

*(nothing yet — 0.1 is the starting point)*

### Remaining

#### Module 0 — Scaffolding & foundation
- **0.1** Next.js (App Router) + TypeScript + Tailwind scaffold; folder structure per
  Section 7; env config (`NEXT_PUBLIC_API_BASE_URL`); `.env.example`
- **0.2** CI/CD: GitHub Actions (typecheck, lint, build) + Vercel deploy; confirm the
  deployed origin is added to the API's `CORS_ALLOWED_ORIGINS`
- **0.3** **Design token extraction pass** — one sweep across every screenshot →
  `design/tokens.md` + Tailwind config. Blocks all UI work; see Section 3
- **0.4** Base primitives from those tokens: Button (all variants), Input, Select,
  Checkbox, Card, Table, Modal, Toast, Badge/status pill, Skeleton

#### Module 1 — API client & auth foundation
- **1.1** Typed fetch client: base URL, bearer injection, `{ error: { message } }` →
  typed `ApiError` with status, per-status mapping (Section 2), no raw validation
  strings reaching the UI
- **1.2** Constants mirror (`ROLES`, `PERMISSIONS`, `ROLE_RANK`,
  `ROLE_DEFAULT_PERMISSIONS`, and every enum) + zod schema mirrors of the backend's
  request schemas
- **1.3** Owner auth: register, login, logout, **serialized rotating refresh**,
  token storage decision (documented), 401 retry-once
- **1.4** Email landing routes: `/verify-email`, `/reset-password`,
  `/forgot-password`, `/confirm-email-change` — hard dependency of the API's mailer
- **1.5** Staff PIN auth: shop-scoped login, sliding session, expiry → re-PIN (no
  refresh path), 429 handling with **no auto-retry**
- **1.6** Actor context + `<PermissionGate>` + `useEffectivePermissions` —
  actor-type-first gating (Section 2)

#### Module 2 — App shell
- **2.1** Dashboard layout, navigation, shop switcher, actor/role display
- **2.2** TanStack Query setup + the shared loading / empty / error / 403 / 404 state
  components every list screen needs
- **2.3** `<ConfirmIrreversible>` primitive for every action in Section 2's
  irreversible list
- **2.4** The **null-vs-omit** PATCH form helper (Section 2) — one implementation,
  used by every edit form in the app

#### Module 3 — Onboarding
- **3.1** Company creation
- **3.2** Business type (`single`/`chain`) + card payment mode (`platform`/`own`) —
  two dedicated actions, not part of the generic PATCH
- **3.3** First shop creation
- **3.4** Onboarding routing guard — driven off `businessType === null`

#### Module 4 — Company & billing
- **4.1** Company profile view/edit
- **4.2** Billing history (`?limit`, the only paginated endpoint besides the audit log)
- **4.3** Derived billing-lock banner + the 402-means-locked branch, scoped to the two
  gated routes only

#### Module 5 — Shops
- **5.1** Shop list
- **5.2** Shop create/edit incl. VAT settings, with a client-side warning on
  `vatRegistered: true` + no `defaultVatRate` (the API silently treats it as 0%)
- **5.3** Shop close (soft delete)
- **5.4** Add-ons (`health_safety`) — activate/deactivate, billing-gated

#### Module 6 — Staff & permissions
- **6.1** Staff list
- **6.2** Staff create + **one-time PIN reveal screen** (copy/print affordance,
  explicit "you will not see this again", not reachable by browser-back)
- **6.3** Staff edit/deactivate, with the strict-rank rule mirrored in the UI
- **6.4** Permission overrides (grant/revoke, additive only)
- **6.5** Permission audit log (`?limit`)

#### Module 7 — Master menu (owner-only)
- **7.1** Categories
- **7.2** Items
- **7.3** Size variants (price is **absolute**, replaces the item price)
- **7.4** Modifier groups, options, and attaching groups to items
- **7.5** Ingredients & allergens (the UK 14)
- **7.6** Recipes at all three levels (item / variant / modifier option) — quantities
  **sum additively**, the opposite of pricing

#### Module 8 — Shop menu
- **8.1** Resolved menu view (the single source of till pricing — never re-derive)
- **8.2** Item + variant overrides (price / enabled), incl. clearing
- **8.3** Modifier option overrides
- **8.4** Shop-local items
- **8.5** Local item modifier groups + recipes

#### Module 9 — Inventory
- **9.1** Item CRUD, `isLowStock`, `?lowStockOnly`, shelf-life and SKU fields
- **9.2** Suppliers CRUD
- **9.3** Item ↔ supplier links + the single default-supplier swap
- **9.4** Ingredient ↔ inventory-item links + conversion factor, **plus a setup
  warning for unlinked ingredients** (the API silently skips them at deduction time
  and never errors)
- **9.5** Cross-shop inventory overview (owner-only)

#### Module 10 — Purchasing & wastage
- **10.1** Purchase orders — **logging only, no stock effect, no status/workflow**
- **10.2** Stock receiving — **this DOES move stock**; multiple partial receipts per
  PO; computed discrepancy that never blocks
- **10.3** Wastage logging — fixed reasons, 409 when wasting more than stock,
  `view_inventory` (so a Chef can log it), immutable

#### Module 11 — Health & safety
- **11.1** Scan by SKU (`sealed`/`opened`) → expiry; 400 when that shelf life isn't
  configured
- **11.2** Latest-scan-per-item view
- **11.3** Expired flags + resolution (optional `wastageLogId`, or plain dismissal);
  **flag-only, never auto-creates wastage or moves stock**
- **11.4** Label print + print history (each print is a new record; reprinting is
  normal)

#### Module 12 — Rota
- **12.1** Shift calendar (`?from`/`?to` **both required**)
- **12.2** Swap requests + approve/reject
- **12.3** Clock in/out
- **12.4** Attendance list + rota-vs-actual comparison

#### Module 13 — Orders (read-only)
- **13.1** Order list (no items, no money — detail fetch required for totals)
- **13.2** Order detail: full money breakdown, VAT decomposition, payments, refunds,
  voided lines struck through, cancellation state

#### Module 14 — Till *(only if scope includes a browser till — see Section 6)*
- **14.1** Cart model built on the resolved menu, carrying `source`
- **14.2** Create order (dine-in table rules, modifier min/max mirrored)
- **14.3** Add items to an open order
- **14.4** Discounts, order-level and per-line (`apply_discount`)
- **14.5** Cancel order / void line (`wasPrepped` required, explicit control)
- **14.6** Payments — cash over-tender + change, card, split/partial, 402 decline
- **14.7** Refunds per payment, full or partial
- **14.8** Offline queue + `POST /orders/sync` (IndexedDB; 201/200/409 contract)

#### Module 15 — KDS *(only if scope includes a browser KDS — BLOCKED, see Section 6)*
- **15.1** Resolve the handshake constraint (proxy route or API change) — **blocking**
- **15.2** Ticket board off `orderNumber` + derived `kitchenStatus`
- **15.3** Per-item status updates, with a confirm step on `ready` (it deducts real
  stock, irreversibly)
- **15.4** Live socket: connect, hydrate from the order list, apply events, handle
  `kds.unauthorized` and the 30s revalidation disconnect

#### Not in the API — build no UI for these
Backend Modules 11 (loyalty/rewards), 12 (reporting/PDF export) and 13 (real payment
provider) **do not exist**. `view_reports` exists as a permission but nothing checks
it. A design screenshot covering any of these cannot be built as drawn.

---

## 6. Known Issues / Environment Notes

- **OPEN DECISION, blocks Modules 14 and 15.** The backend's own notes say the
  clients are "Next.js web dashboard (Vercel), Android/iOS native apps (till + KDS)".
  Confirm whether this repo is **(A)** dashboard only, **(B)** dashboard + browser
  till, or **(C)** dashboard + browser KDS. Assume **(A)** until answered.
  - **(C) has a hard technical blocker**: the KDS socket authenticates via an
    `Authorization: Bearer` header on the handshake, and **browsers cannot set
    headers on `new WebSocket(...)`**. It needs either a backend change
    (query-string/cookie auth on upgrade) or a same-origin Next.js proxy route that
    injects the header. Neither exists today.
  - **(B) has a softer one**: offline sync is designed for a native till with a
    durable local queue. IndexedDB can approximate it, but that's a real design
    decision, not a detail.
- **CORS**: the deployed origin must be in the API's `CORS_ALLOWED_ORIGINS`. **Vercel
  preview deployments get a new origin per branch and will be blocked** unless listed
  — it presents as a mysterious network failure, so plan for it.
- **Bearer tokens, not cookies.** The API sets `credentials: true` but issues no
  cookies. Decide storage deliberately (in-memory + refresh-on-load is the safer
  default; `localStorage` is XSS-exposed) and document the choice in 1.3.
- **Rate limits**: 300 req / 15 min globally per IP; **10 staff PIN attempts / 15 min
  per (IP, shop)**. Never auto-retry a failed PIN login. Be careful with aggressive
  polling or refetch-on-focus.
- **No pagination anywhere** except `?limit` on billing history and the permission
  audit log. Every list endpoint returns everything — paginate/virtualize client-side
  and expect large payloads on a busy shop's order or scan history.
- **No search or filter params** beyond `?lowStockOnly`, `?categoryId`, `?status`
  (swap requests), `?from`/`?to` (rota + attendance, **both required**), `?staffId`,
  `?limit`. Everything else filters client-side.
- **KDS sockets have no replay/backfill.** On connect or reconnect, fetch the order
  list and hydrate, then apply events on top.
- **The KDS connection registry is in-memory and per-process** — correct for the
  single Render instance today, but it would not fan out under horizontal scaling.
- **A £0 order cannot be marked paid** (e.g. after a 100% discount) — it stays `open`
  and a payment against it is rejected as "no outstanding balance". Handle explicitly.
- **Mixed VAT rates in one basket are not supported** — one shop-level rate applies to
  the whole order (hot food vs. a zero-rated cold drink is not modelled).
- **Soft-deleted menu items block offline sync** — an item deleted between an offline
  sale and its sync returns 404 and cannot be synced.
- **Order numbering resets at midnight UTC**, not at close of trade — a late-night
  venue's numbers roll over at 1–2am local. Don't imply otherwise in the UI.

---

## 7. Key File Structure

```
app/
  (auth)/            login, register, forgot-password, verify-email,
                     reset-password, confirm-email-change   [Module 1.3/1.4]
  (dashboard)/
    onboarding/                                             [Module 3]
    billing/         REQUIRED route - linked from billing emails  [Module 4]
    company/                                                [Module 4]
    shops/                                                  [Module 5]
    shops/[shopId]/
      staff/         incl. the one-time PIN reveal          [Module 6]
      menu/          resolved menu, overrides, local items  [Module 8]
      inventory/     items, suppliers, links                [Module 9]
      purchasing/    POs, receiving, wastage                [Module 10]
      health-safety/ scans, latest, expired, prints         [Module 11]
      rota/          shifts, swaps, attendance              [Module 12]
      orders/        history + detail                       [Module 13]
    menu/            MASTER menu - company-level, owner-only [Module 7]
  (till)/            only under scope B                     [Module 14]
  (kds)/             only under scope C                     [Module 15]
lib/
  api/
    client.ts        fetch wrapper: base URL, auth header, error envelope -> ApiError
    auth-owner.ts    JWT + SERIALIZED rotating refresh
    auth-staff.ts    PIN session, sliding window, no refresh
    endpoints/       one module per API area, mirroring the backend's modules
  schemas/           zod mirrors of the backend's request schemas
  constants.ts       ROLES, PERMISSIONS, ROLE_RANK, ROLE_DEFAULT_PERMISSIONS + enums
                     - the ONE copy, every UI label derives from it
  money.ts           display formatting ONLY, no arithmetic
  dates.ts           date-string vs instant helpers
  forms.ts           the null-vs-omit PATCH helper
components/
  permission-gate.tsx        actor-type-first gating
  confirm-irreversible.tsx   for every irreversible action
  states/                    loading / empty / error / forbidden / not-found
design/                      screenshots + tokens.md - not shipped
docs/
  API_REFERENCE.md           the contract - read every session
```

---

## 8. Tools & Resources

Next.js (App Router), TypeScript, Tailwind CSS, TanStack Query, zod, React Hook Form,
Vercel, GitHub Actions.

Backend: Express 4 + PostgreSQL on Render, `ws` for the KDS socket.
Repo: `https://github.com/md-motiur-rahman/ezpos_api.git` — the canonical source of
truth for API behaviour. **When `docs/API_REFERENCE.md` and the running server
disagree, the server wins**; fix the doc in the same turn.

# EzPOS API Reference

The contract the Next.js dashboard and the native till/KDS apps build against.
**Derived from the route, validation and service files on `master`** — Modules 0–10
complete, **162 REST endpoints + 1 WebSocket**.

This document is organised by *what you are building*, not by backend module number:

| Part | For |
|---|---|
| [1. Connecting](#1-connecting) | base URLs, errors, status codes, limits |
| [2. Authentication](#2-authentication) | the two token systems |
| [3. Authorization](#3-authorization) | roles, permissions, tenancy |
| [4. Endpoint index](#4-endpoint-index) | **every endpoint, one row each** |
| [5. Owner dashboard](#5-owner-dashboard) | company, shops, master menu, staff, rota |
| [6. Shop floor](#6-shop-floor) | resolved menu, inventory, suppliers, wastage, H&S |
| [7. Till](#7-till) | orders, discounts, payments, refunds, offline sync |
| [8. Kitchen display](#8-kitchen-display) | the WebSocket and its narrowed payload |
| [9. Cross-cutting rules](#9-cross-cutting-rules) | money, dates, nullable fields |
| [10. Traps](#10-traps) | **read before building anything** |
| [11. Not built yet](#11-not-built-yet) | do not design around these |

---

## 1. Connecting

**Base URL**

| Environment | URL |
|---|---|
| Production | `https://pos-api-52vj.onrender.com` |
| Local | `http://localhost:<PORT>` (`PORT` from your `.env`, 4000 in the sample) |

Every path in this document is absolute from the base URL. Set it once as
`NEXT_PUBLIC_API_BASE_URL`; never hardcode it at a call site.

> The production host is a Render **free** instance and **spins down after ~15
> minutes idle**. The first request after a spin-down takes several seconds and a
> WebSocket will have been dropped. Do not treat that latency as a bug, and give
> the KDS a reconnect loop.

**Content type:** `application/json` everywhere. The one exception is
`POST /api/webhooks/stripe`, which Stripe calls with a raw body — not the frontend.

**Error envelope — every non-2xx response, no exceptions:**

```json
{ "error": { "message": "Human-readable message" } }
```

There is no `code`, no `fields[]`, no `details`. Validation failures arrive as a
single 400 with every issue joined into one string:

```
"Invalid request body - items.0.quantity: quantity must be greater than 0; type: Invalid enum value"
```

**Never render that string to an end user.** Branch on the status code, and where
you need field-level errors, validate client-side first against a zod mirror of the
server schema.

**Status codes**

| Code | Meaning in this API |
|---|---|
| 200 | OK |
| 201 | Created — also an offline sync's *first* call |
| 400 | Validation failure, **or** a business rule refusing the action (over-discount, over-refund, wasting more than stock, un-expired scan, cancelled-order guards, rota disabled, owner trying to clock in) |
| 401 | Missing / invalid / expired token |
| 402 | Billing locked, **or** a declined card payment or refund |
| 403 | Authenticated but lacking the permission, or outranked by the target staff member |
| 404 | Not found **or outside the actor's tenancy** |
| 409 | Conflict — duplicate SKU, already-resolved scan, offline-sync payload mismatch, wastage exceeding stock |
| 429 | Rate limited |
| 500 | Internal error — the message is always literally `"Internal server error"` |

**Rate limits**

- Global: **300 requests / 15 min** per client IP.
- `POST /api/staff-auth/login`: **10 attempts / 15 min**, keyed by *(IP, shopId)* —
  so one shop's failed PINs cannot lock out another shop behind the same NAT.
- The WebSocket upgrade is **not** rate limited (it never passes through Express).

Surface a 429 as "too many attempts, try again shortly" and **never auto-retry** it.

**CORS:** your origin must appear in the API's `CORS_ALLOWED_ORIGINS`. `credentials:
true` is set, but this API uses **bearer tokens, not cookies**.

> Currently `CORS_ALLOWED_ORIGINS` is **unset** on the production service, and with
> `NODE_ENV=production` the API therefore rejects **every** browser origin. Your
> Vercel domain must be added before the dashboard can call it. Native apps are
> unaffected — CORS is a browser mechanism.

---

## 2. Authentication

Two kinds of caller, two token systems, **not interchangeable** — both riding the
same `Authorization: Bearer` header, which is exactly why they need **separate
storage keys and separate contexts**. One shared "token" slot will eventually send a
staff token to an owner-only route, and the resulting 401 is baffling because both
tokens look identical on the wire.

### Owner — the dashboard user

- `Authorization: Bearer <accessToken>` — a **JWT, 15 minutes**.
- Refreshed with an opaque, **rotating**, server-stored refresh token.
- **Rotation means each refresh invalidates the token you sent.** Two concurrent
  refreshes guarantee one failure and can log the user out.
  **Serialize refreshes**: one in-flight promise that every queued 401 awaits, never
  one refresh per request.

### Staff — till and KDS

- `Authorization: Bearer <sessionToken>` — an **opaque DB-stored token**, sliding
  **60-minute** window that any authenticated request extends.
- Obtained with an 8-digit `staffIdCode` + 8-digit `pin` against a specific `shopId`.
- **There is no staff refresh endpoint.** On expiry, the user re-enters their PIN.
- A connected KDS socket keeps the session alive on its own heartbeat.

### Which token does a route accept?

| Middleware | Accepts | Applies to |
|---|---|---|
| `requireAuth` | Owner JWT **only** | `/api/me`, all `/api/companies/*` (incl. master menu and inventory-overview), `/api/shops` CRUD and add-ons |
| `requireStaffOrOwnerAuth` | **Either** | every `/api/shops/:shopId/<resource>` route, and `/api/staff-permissions` |
| none | — | `/api/auth/*`, `/api/staff-auth/*`, `/api/webhooks/stripe`, `/health` |

`requireStaffOrOwnerAuth` tries the cheap synchronous JWT check first and only falls
through to a staff-session DB lookup if that fails. It sets
`req.actor = { type: 'owner' | 'staff', id, … }`.

---

## 3. Authorization

**Roles:** `owner`, `manager`, `shift_manager`, `server`, `chef`.
`owner` is the account holder, not a staff row.

**Rank:** owner 4 > manager 3 > shift_manager 2 > server 1 = chef 1.
A staff member may only create, edit or deactivate someone **strictly below** their
own rank — which is why "a Manager cannot create another Manager" needs no special
case. Server and Chef are deliberately equal; neither outranks the other.

**The owner bypasses the permission system entirely.** Every check below applies to
staff actors only. **Gate your UI on actor type first, then permission** — branching
on permission alone gives the owner a crippled dashboard.

**The 13 permissions and their role defaults**

| Permission | Manager | Shift Mgr | Server | Chef |
|---|:--:|:--:|:--:|:--:|
| `view_inventory` | ✅ | | | ✅ |
| `manage_inventory` | ✅ | | | |
| `request_stock_order` | | | | ✅ |
| `manage_stock_orders` | ✅ | | | |
| `manage_staff` | ✅ | | | |
| `access_till` | ✅ | ✅ | ✅ | |
| `perform_health_safety` | ✅ | ✅ | ✅ | ✅ |
| `grant_permissions` | ✅ | | | |
| `manage_rota` | ✅ | | | |
| `manage_menu` | ✅ | | | |
| `apply_discount` | ✅ | ✅ | | |
| `view_kds` | ✅ | ✅ | | ✅ |
| `view_reports` | | | | |

`view_reports` has no default holder and **nothing checks it yet** (Module 12).

**Overrides are additive only.** The effective set is `role defaults ∪ active
overrides`. There is no deny-list, so an override can never strip a role's own
default. Grant with `POST /api/staff-permissions/:staffId`.

**Permission-gated UI is a mirror, never the enforcement.** Use it to hide or
disable controls; the server is the authority and a 403 must still render
gracefully.

### The Chef/till split is load-bearing

The Chef is the KDS's primary user and has **no `access_till`** — deliberately. So
`GET /api/shops/:id/orders/:orderId` correctly **403s a Chef**, and the KDS instead
receives a **narrowed payload with every monetary field stripped** (§8). Do not
build a kitchen screen that calls the orders REST endpoints as a Chef; it will fail.

### Tenancy is enforced by 404, not 403

Anything outside the actor's company or shop returns **404**. Never render "this was
deleted" on a 404 — render **"not found, or you don't have access"**.

---

## 4. Endpoint index

Every endpoint, one row each. `owner` = owner JWT only; `either` =
`requireStaffOrOwnerAuth`. The permission column applies to **staff actors only**.

### Public — no token

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{ status, db, environment, timestamp }` · 503 if the DB is down |
| POST | `/api/auth/register` | |
| POST | `/api/auth/verify-email` | |
| POST | `/api/auth/resend-verification` | |
| POST | `/api/auth/login` | |
| POST | `/api/auth/refresh` | rotates |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/forgot-password` | |
| POST | `/api/auth/reset-password` | |
| POST | `/api/auth/confirm-email-change` | |
| POST | `/api/staff-auth/login` | rate limited 10/15min per (IP, shop) |
| POST | `/api/staff-auth/logout` | |
| POST | `/api/webhooks/stripe` | Stripe only — not for the frontend |

### Owner profile & company — owner JWT

| Method | Path | Notes |
|---|---|---|
| GET · PATCH | `/api/me` | |
| POST | `/api/me/change-password` | |
| POST | `/api/me/change-email` | sets `pendingEmail` |
| POST | `/api/companies` | one per owner; grants the one-time trial |
| GET · PATCH · DELETE | `/api/companies/mine` | PATCH cannot set `businessType` / `cardPaymentMode` |
| POST | `/api/companies/mine/business-type` | |
| POST | `/api/companies/mine/card-payment-mode` | |
| GET | `/api/companies/mine/billing-history` | `?limit=1..100` |
| GET | `/api/companies/mine/inventory-overview` | `?lowStockOnly=true` — cross-shop |

### Shops & add-ons — owner JWT

| Method | Path | Notes |
|---|---|---|
| POST | `/api/shops` | **402 if billing locked** |
| GET | `/api/shops` | |
| GET · PATCH · DELETE | `/api/shops/:id` | DELETE is a soft delete |
| POST | `/api/shops/:shopId/addons` | **402 if billing locked** |
| GET | `/api/shops/:shopId/addons` | |
| DELETE | `/api/shops/:shopId/addons/:addonType` | |

### Master menu — owner JWT only, staff cannot reach these

| Method | Path |
|---|---|
| POST · GET | `/api/companies/mine/menu-categories` |
| PATCH · DELETE | `/api/companies/mine/menu-categories/:categoryId` |
| POST · GET | `/api/companies/mine/menu-items` |
| GET · PATCH · DELETE | `/api/companies/mine/menu-items/:itemId` |
| POST · GET | `/api/companies/mine/menu-items/:itemId/variants` |
| PATCH · DELETE | `/api/companies/mine/menu-items/:itemId/variants/:variantId` |
| POST · GET | `/api/companies/mine/modifier-groups` |
| PATCH · DELETE | `/api/companies/mine/modifier-groups/:groupId` |
| POST · GET | `/api/companies/mine/modifier-groups/:groupId/options` |
| PATCH · DELETE | `/api/companies/mine/modifier-groups/:groupId/options/:optionId` |
| POST · DELETE | `/api/companies/mine/menu-items/:itemId/modifier-groups/:groupId` |
| GET | `/api/companies/mine/menu-items/:itemId/modifier-groups` |
| POST · GET | `/api/companies/mine/ingredients` |
| PATCH · DELETE | `/api/companies/mine/ingredients/:ingredientId` |
| POST · PATCH · DELETE | `/api/companies/mine/menu-items/:itemId/ingredients/:ingredientId` |
| GET | `/api/companies/mine/menu-items/:itemId/ingredients` |
| POST · PATCH · DELETE | `/api/companies/mine/menu-items/:itemId/variants/:variantId/ingredients/:ingredientId` |
| GET | `/api/companies/mine/menu-items/:itemId/variants/:variantId/ingredients` |
| POST · PATCH · DELETE | `/api/companies/mine/modifier-groups/:groupId/options/:optionId/ingredients/:ingredientId` |
| GET | `/api/companies/mine/modifier-groups/:groupId/options/:optionId/ingredients` |

**40 endpoints.**

### Staff & permission overrides — either token

| Method | Path | Staff permission |
|---|---|---|
| POST | `/api/shops/:shopId/staff` | `manage_staff` + outrank |
| GET | `/api/shops/:shopId/staff` | — (scope only) |
| GET | `/api/shops/:shopId/staff/:staffId` | — (scope only) |
| PATCH · DELETE | `/api/shops/:shopId/staff/:staffId` | `manage_staff` + outrank |
| GET | `/api/staff-permissions/shop/:shopId/audit-log` | `grant_permissions` |
| GET | `/api/staff-permissions/:staffId` | — (scope only) |
| POST | `/api/staff-permissions/:staffId` | `grant_permissions` + outrank |
| DELETE | `/api/staff-permissions/:staffId/:permission` | `grant_permissions` + outrank |

Note the shape: `:staffId` alone, **no `:shopId`** except on the audit log.

### Rota — either token · **every route 400s unless the shop has `rotaEnabled`**

| Method | Path | Staff permission |
|---|---|---|
| POST | `/api/shops/:shopId/rota-shifts` | `manage_rota` |
| GET | `/api/shops/:shopId/rota-shifts` | — (`?from=&to=` both required) |
| GET | `/api/shops/:shopId/rota-shifts/:shiftId` | — |
| PATCH · DELETE | `/api/shops/:shopId/rota-shifts/:shiftId` | `manage_rota` |
| POST | `/api/shops/:shopId/swap-requests` | — **for your own shift**; `manage_rota` for anyone else's |
| GET | `/api/shops/:shopId/swap-requests` | — (`?status=`) |
| GET | `/api/shops/:shopId/swap-requests/:requestId` | — |
| POST | `/api/shops/:shopId/swap-requests/:requestId/approve` | `manage_rota` |
| POST | `/api/shops/:shopId/swap-requests/:requestId/reject` | `manage_rota` |
| POST | `/api/shops/:shopId/attendance/clock-in` | **staff actor only** — an owner gets 400 |
| POST | `/api/shops/:shopId/attendance/clock-out` | **staff actor only** — an owner gets 400 |
| GET | `/api/shops/:shopId/attendance/comparison` | `manage_rota` (always) |
| GET | `/api/shops/:shopId/attendance` | — but **silently narrowed to your own** without `manage_rota` |
| GET | `/api/shops/:shopId/attendance/:recordId` | — for your own; **403** for anyone else's without `manage_rota` |

### Shop menu — either token · `GET` open, **every mutation needs `manage_menu`**

| Method | Path |
|---|---|
| GET | `/api/shops/:shopId/menu` — **the resolved menu** |
| PATCH · DELETE | `/api/shops/:shopId/menu/overrides/:menuItemId` |
| PATCH · DELETE | `/api/shops/:shopId/menu/variants/:variantId` |
| PATCH · DELETE | `/api/shops/:shopId/menu/modifier-options/:optionId` |
| POST · GET | `/api/shops/:shopId/menu/items` |
| GET · PATCH · DELETE | `/api/shops/:shopId/menu/items/:itemId` |
| POST · DELETE | `/api/shops/:shopId/menu/items/:itemId/modifier-groups/:groupId` |
| POST · PATCH · DELETE | `/api/shops/:shopId/menu/items/:itemId/ingredients/:ingredientId` |
| GET | `/api/shops/:shopId/menu/items/:itemId/ingredients` |

**18 endpoints.**

### Inventory & suppliers — either token · reads `view_inventory`, writes `manage_inventory`

| Method | Path | Staff permission |
|---|---|---|
| POST | `/api/shops/:shopId/inventory-items` | `manage_inventory` |
| GET | `/api/shops/:shopId/inventory-items` | `view_inventory` (`?lowStockOnly=true`) |
| GET | `/api/shops/:shopId/inventory-items/:itemId` | `view_inventory` |
| PATCH · DELETE | `/api/shops/:shopId/inventory-items/:itemId` | `manage_inventory` |
| POST · PATCH · DELETE | `/api/shops/:shopId/inventory-items/:itemId/suppliers/:supplierId` | `manage_inventory` |
| GET | `/api/shops/:shopId/inventory-items/:itemId/suppliers` | `view_inventory` |
| POST · PATCH · DELETE | `/api/shops/:shopId/inventory-items/:itemId/ingredient-links/:ingredientId` | `manage_inventory` |
| GET | `/api/shops/:shopId/inventory-items/:itemId/ingredient-links` | `view_inventory` |
| POST | `/api/shops/:shopId/suppliers` | `manage_inventory` |
| GET | `/api/shops/:shopId/suppliers` | `view_inventory` |
| GET | `/api/shops/:shopId/suppliers/:supplierId` | `view_inventory` |
| PATCH · DELETE | `/api/shops/:shopId/suppliers/:supplierId` | `manage_inventory` |
| POST | `/api/shops/:shopId/purchase-orders` | `manage_inventory` |
| GET | `/api/shops/:shopId/purchase-orders` | `view_inventory` |
| GET | `/api/shops/:shopId/purchase-orders/:poId` | `view_inventory` |
| DELETE | `/api/shops/:shopId/purchase-orders/:poId` | `manage_inventory` |
| POST | `/api/shops/:shopId/purchase-orders/:poId/receipts` | `manage_inventory` |
| POST · GET | `/api/shops/:shopId/wastage-logs` | **`view_inventory` for both** |
| GET | `/api/shops/:shopId/wastage-logs/:wastageLogId` | `view_inventory` |

### Health & safety — either token · **all `perform_health_safety`**

| Method | Path |
|---|---|
| POST · GET | `/api/shops/:shopId/inventory-scans` |
| GET | `/api/shops/:shopId/inventory-scans/latest` |
| GET | `/api/shops/:shopId/inventory-scans/expired` |
| GET | `/api/shops/:shopId/inventory-scans/:scanId` |
| POST | `/api/shops/:shopId/inventory-scans/:scanId/print` |
| GET | `/api/shops/:shopId/inventory-scans/:scanId/prints` |
| POST | `/api/shops/:shopId/inventory-scans/:scanId/resolve` |
| GET | `/api/shops/:shopId/inventory-scans/:scanId/resolution` |

### Orders / till — either token

| Method | Path | Staff permission |
|---|---|---|
| POST · GET | `/api/shops/:shopId/orders` | `access_till` |
| POST | `/api/shops/:shopId/orders/sync` | `access_till` |
| GET | `/api/shops/:shopId/orders/:orderId` | `access_till` |
| POST | `/api/shops/:shopId/orders/:orderId/items` | `access_till` |
| PATCH | `/api/shops/:shopId/orders/:orderId/discount` | **`apply_discount`** |
| PATCH | `/api/shops/:shopId/orders/:orderId/items/:orderItemId/discount` | **`apply_discount`** |
| POST | `/api/shops/:shopId/orders/:orderId/cancel` | `access_till` |
| POST | `/api/shops/:shopId/orders/:orderId/items/:orderItemId/void` | `access_till` |
| PATCH | `/api/shops/:shopId/orders/:orderId/items/:orderItemId/status` | **`view_kds`** |
| POST | `/api/shops/:shopId/orders/:orderId/payments` | `access_till` |
| POST | `/api/shops/:shopId/orders/:orderId/payments/:paymentId/refund` | **`apply_discount`** |

**There is no DELETE anywhere in the orders module.** Cancel, void and refund are
explicit, one-directional actions that create records; nothing is ever removed.

### WebSocket

| Path | Permission |
|---|---|
| `GET wss://<host>/api/shops/:shopId/kds/socket` | `view_kds` |

### Totals

| Area | Count |
|---|---:|
| Health | 1 |
| Owner auth + profile | 13 |
| Staff auth | 2 |
| Company + billing | 7 |
| Master menu | 40 |
| Cross-shop inventory overview | 1 |
| Shops + add-ons | 8 |
| Staff + permission overrides | 9 |
| Rota | 15 |
| Shop menu | 18 |
| Inventory + supplier/ingredient links | 13 |
| Suppliers | 5 |
| Purchase orders + receiving | 5 |
| Wastage | 3 |
| Health & safety scans | 9 |
| Orders / till | 12 |
| Stripe webhook | 1 |
| **Total REST** | **162** |
| WebSocket | 1 |

---

## 5. Owner dashboard

### Auth flows and the pages you must provide

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/auth/register` | `{ email, password (min 10), fullName }` | 201 `{ message, user: { id, email, fullName } }` |
| `POST /api/auth/verify-email` | `{ token }` | `{ message }` |
| `POST /api/auth/resend-verification` | `{ email }` | `{ message }` — always identical, no account enumeration |
| `POST /api/auth/login` | `{ email, password }` | `{ accessToken, refreshToken, user: { id, email } }` |
| `POST /api/auth/refresh` | `{ refreshToken }` | `{ accessToken, refreshToken }` — **rotated** |
| `POST /api/auth/logout` | `{ refreshToken }` | `{ message }` — no-op on an unknown token |
| `POST /api/auth/forgot-password` | `{ email }` | `{ message }` — always identical |
| `POST /api/auth/reset-password` | `{ token, newPassword (min 10) }` | `{ message }` |
| `POST /api/auth/confirm-email-change` | `{ token }` | `{ message, email }` |

The API builds email links from its `FRONTEND_URL`, so the dashboard **must** serve
these landing routes:

- `/verify-email?token=…`
- `/reset-password?token=…`
- `/confirm-email-change?token=…`
- `/billing` — linked from billing-failure emails

> `FRONTEND_URL` is currently the placeholder `https://REPLACE-ME.vercel.app` on the
> production API. Until it is set to the real domain, every emailed link is broken.

**Profile — `/api/me`:** `GET` and `PATCH { fullName }` return
`{ id, email, fullName, emailVerified, pendingEmail }`.
`POST /change-password { currentPassword, newPassword }`.
`POST /change-email { currentPassword, newEmail }` sets `pendingEmail`; a
confirmation email completes the change.

### Company

`POST /api/companies` — `{ name, addressLine1, addressLine2?, city, postcode,
country, phone, vatNumber?, companyNumber? }`. One company per owner; creating it
grants the one-time trial.

```jsonc
// GET /api/companies/mine
{
  "id", "name", "addressLine1", "addressLine2", "city", "postcode", "country",
  "phone", "vatNumber", "companyNumber",
  "businessType": "single" | "chain" | null,   // null until set — drive onboarding off this
  "cardPaymentMode": "platform" | "own",       // never null; defaults to "platform"
  "trialEndsAt", "subscriptionStatus", "gracePeriodEndsAt",
  "createdAt", "updatedAt"
}
```

`PATCH /mine` accepts any subset of the create fields but **cannot** set
`businessType` or `cardPaymentMode`. Each of those has a dedicated action, because
each decides something structural:

- `POST /mine/business-type` — `{ businessType: 'single' | 'chain' }`
- `POST /mine/card-payment-mode` — `{ cardPaymentMode: 'platform' | 'own' }`

**Billing lock.** When billing lapses past the grace period, **402** is returned on
exactly two routes: `POST /api/shops` and `POST /api/shops/:shopId/addons`. Staff
PIN login also fails. Everything else stays open — viewing, editing and closing
shops, and billing history — so the owner can see and *reduce* their bill.

**There is no `isBillingLocked` flag.** Derive the banner from `subscriptionStatus`
+ `gracePeriodEndsAt`.

**`cardPaymentMode` semantics**

| Mode | Behaviour |
|---|---|
| `platform` | Cards go through our provider. The payment row gets a `providerReference`. A decline returns **402**. |
| `own` | The shop uses its own terminal. The till still records `method: "card"` with full card semantics (fixed amount, capped at the balance, no over-tender or change), but **no provider is called** and `providerReference` is `null`. |

Refunds key off the **payment's own `providerReference`**, never the company's
current mode — so switching terminals between taking a payment and refunding it is
always handled correctly.

`GET /mine/billing-history?limit=1..100` (default 10) → `{ invoices: [...], hasMore }`.
Stripe invoices; **not** billing-gated.

### Shops

`POST /api/shops` — `{ name, addressLine1, addressLine2?, city, postcode, country,
phone, kdsEnabled?, rotaEnabled?, vatRegistered, defaultVatRate? }`.
**`vatRegistered` is required**; `defaultVatRate` is 0–100.

Response: `{ id, name, addressLine1, addressLine2, city, postcode, country, phone,
kdsEnabled, rotaEnabled, vatRegistered, defaultVatRate, createdAt, updatedAt }`.

- **`rotaEnabled` is enforced** — every rota route returns **400 "Rota is not enabled
  for this shop"** when it is false. Hide the whole rota section rather than letting
  users hit that error.
- **`kdsEnabled` is *not* enforced anywhere.** The KDS socket works regardless. Treat
  it as a display preference only, and do not rely on it to gate access.
- A shop with `vatRegistered: true` and no `defaultVatRate` is treated as **0%** at
  order time. The API will not block a sale over an owner's misconfiguration, so the
  **frontend should warn on the shop settings screen**.

**Add-ons:** `POST /:shopId/addons { addonType: 'health_safety' }` (402 if billing
locked), `GET /:shopId/addons`, `DELETE /:shopId/addons/:addonType`.
`health_safety` is the only type today.

> **The add-on is not enforced.** Nothing in the health & safety module checks
> whether it is active — the scan endpoints work either way. Gate the H&S UI on the
> add-on yourself if that is the product intent.

### Master menu — `/api/companies/mine/…`

Company-level master data, **owner JWT only**. Staff cannot reach these routes at
all; they work against the resolved shop menu (§6).

| Resource | Body |
|---|---|
| Categories | `{ name, displayOrder? }`; PATCH adds `isActive?` |
| Items | `{ categoryId, name, description?, price, displayOrder? }`; `GET /menu-items?categoryId=` |
| Variants | `{ name, price, displayOrder? }` |
| Modifier groups | `{ name, minSelections?, maxSelections? }` |
| Modifier options | `{ name, priceDelta?, displayOrder? }` |
| Ingredients | `{ name, unit, allergens?: Allergen[] }` |
| Recipes (all three levels) | `{ quantity: number > 0 }` |

**Two pricing rules that are deliberately different shapes:**

- A **variant price is ABSOLUTE** — it *replaces* the item's price.
- A modifier option's **`priceDelta` is ADDITIVE** and may be negative.

**Recipes sum ADDITIVELY** across base item + variant + modifiers — the opposite
shape from pricing. A variant recipe lists only the **extra** over the base.

`Allergen` ∈ `celery, gluten, crustaceans, eggs, fish, lupin, milk, molluscs,
mustard, tree_nuts, peanuts, sesame, soybeans, sulphites` (the UK 14).

### Staff

Writes need **`manage_staff`** *and* strictly outranking the target. Reads are open
to any in-scope actor.

`POST /` — `{ fullName, role: 'manager' | 'shift_manager' | 'server' | 'chef' }`
Response: `{ id, shopId, fullName, role, staffIdCode, createdAt, updatedAt }`.

> **The 201 from `POST` is the only time the `pin` is ever returned.** It is never
> retrievable again. Show it once, prominently, with a copy/print affordance and an
> explicit "you will not see this again" warning.

**Permission overrides — `/api/staff-permissions`:** `POST /:staffId
{ permission }`, `DELETE /:staffId/:permission`, `GET /:staffId` (effective set),
`GET /shop/:shopId/audit-log?limit=1..100`.

### Rota

**Every route here 400s unless the shop has `rotaEnabled: true`.**

| Resource | Body / query |
|---|---|
| `rota-shifts` POST/PATCH | `{ staffId, startTime, endTime, notes? }` — ISO datetimes, `endTime > startTime` |
| `rota-shifts` GET | `?from=&to=` — **both required**, `to > from` |
| `swap-requests` POST | `{ shiftId, toStaffId, notes? }` — `toStaffId` must differ from the shift's current staff |
| `swap-requests` GET | `?status=pending\|approved\|rejected` |
| `attendance` clock-in/out | **no body** — the actor clocks *themselves* |
| `attendance` GET | `?from=&to=&staffId=` — `from`/`to` **required** |

**Self-service vs. management — the distinction the UI must respect:**

- **Creating a swap request for your own shift needs no permission.** Requesting one
  on someone *else's* shift requires `manage_rota`. Approve and reject always
  require it.
- **`GET /attendance` silently narrows to your own records** when you lack
  `manage_rota` — a `staffId` query param is *ignored*, not rejected. Do not present
  a staff filter to users without the permission; it will appear broken.
- **`GET /attendance/:recordId` behaves differently**: it **403s** on someone else's
  record instead of narrowing. Listing is "show me what I may see"; fetching one is
  an explicit boundary.
- **Only staff can clock in or out.** An owner gets **400 "Only staff can clock in or
  out"**. Hide the clock-in control entirely in the owner dashboard.

`GET /attendance/comparison?from=&to=&staffId=` requires `manage_rota` regardless of
whose attendance it is. Each row is classified `no_show`, `completed`,
`in_progress` or `unscheduled`. It deliberately does **not** compute "late" or "left
early" — that needs a tolerance threshold nobody has specified. Raw
scheduled-vs-actual timestamps are returned so you can decide client-side.

`/comparison` is registered before `/:recordId`; do not rely on any other ordering.

---

## 6. Shop floor

### The resolved menu — `GET /api/shops/:shopId/menu`

**This is THE endpoint the till renders from.** It already applies every shop-level
price and enabled override for items, variants *and* modifier options. Never
re-derive pricing on the client.

```jsonc
[
  {
    "id": "uuid",
    "source": "master" | "local",   // decides which id field you send on an order
    "categoryId": "uuid",
    "name": "…", "description": "…",
    "price": 8.5,                    // EFFECTIVE price, override applied
    "masterPrice": 9.0,              // null for local items
    "isEnabled": true,               // local items are always true
    "displayOrder": 1,
    "variants": [
      { "id", "name", "price", "masterPrice", "isEnabled", "displayOrder" }
    ],                               // always [] for local items
    "modifierGroups": [ /* each with minSelections / maxSelections and options */ ],
    "allergens": ["gluten", "milk"]  // aggregated from the recipe
  }
]
```

> **Critical for ordering:** an item with `source: "master"` is ordered as
> `menuItemId`; `source: "local"` is ordered as `shopMenuItemId`. **Exactly one of
> the two, never both** — sending both, or neither, is a 400.

**Overrides** (all `manage_menu`): `PATCH /overrides/:menuItemId
{ isEnabled?, priceOverride? }`, `PATCH /variants/:variantId
{ isEnabled?, priceOverride? }`, `PATCH /modifier-options/:optionId
{ isEnabled?, priceDeltaOverride? }`. The matching `DELETE` clears the override and
reverts to the master value.

**Shop-local items** live only in this shop: `POST /items { categoryId, name,
description?, price, displayOrder? }`, plus modifier-group attach/detach and
recipe management under `/items/:itemId/…`.

### Inventory — `/api/shops/:shopId/inventory-items`

Reads need **`view_inventory`**, mutations **`manage_inventory`** — reads included,
unlike the menu. Stock is back-of-house.

`POST` / `PATCH` body: `{ name, unit, quantityOnHand?, lowStockThreshold?,
shelfLifeDays?, shelfLifeOpenedDays?, sku? }`. On `PATCH` every field is optional
and `lowStockThreshold`, `shelfLifeDays`, `shelfLifeOpenedDays` and `sku` are
**nullable** — see [§9](#9-cross-cutting-rules).

- `isLowStock` is **computed at response time** from `quantityOnHand` vs
  `lowStockThreshold`. Never send it; it is never stored.
- `sku` is unique **per shop** (409 on duplicate). The same barcode legitimately
  recurs across shops in a chain.
- `GET /?lowStockOnly=true` filters server-side.

**Item ↔ supplier links:** `POST /:itemId/suppliers/:supplierId { isDefault? }`,
`PATCH … { isDefault }`, `DELETE …`, `GET /:itemId/suppliers`.
At most one default per item; setting a new one swaps atomically.

**Ingredient ↔ inventory-item links — the deduction bridge:**
`POST /:itemId/ingredient-links/:ingredientId { conversionFactor? }`,
`PATCH … { conversionFactor }` (required), `DELETE …`, `GET /:itemId/ingredient-links`.

`conversionFactor` = inventory units per 1 ingredient unit — a recipe in grams
against stock held in 25 kg sacks. One link per `(shop, ingredient)`.

> **An ingredient with no link is silently skipped at deduction time.** The API will
> not error, so stock quietly fails to move. The frontend should surface unlinked
> ingredients as a **setup warning** on the inventory screen — this is the single
> most likely cause of "why isn't my stock going down".

**Cross-shop view:** `GET /api/companies/mine/inventory-overview?lowStockOnly=true`
is **owner JWT only** — no staff role has authority spanning more than one shop.
Flat list of every active item in every active shop, each row tagged `shopId` /
`shopName`, with the same computed `isLowStock`.

### Suppliers

`POST /` · `GET /` · `GET /:supplierId` · `PATCH /:supplierId` · `DELETE /:supplierId`
Body `{ name, contactName?, phone?, email?, notes? }` — all but `name` optional.

### Purchase orders & receiving

| Endpoint | Body |
|---|---|
| `POST /purchase-orders` | `{ supplierId, orderedAt?, notes?, items: [{ inventoryItemId, quantity, unitCost? }] }` |
| `POST /purchase-orders/:poId/receipts` | `{ receivedAt?, notes?, items: [{ purchaseOrderItemId, quantityReceived }] }` |

- At least one line item is required, and **duplicate ids within one array are
  rejected (400)**.
- **A PO is logging only** — creating one does *not* move stock, and there is no
  status or workflow field. Do not build an approval flow against it.
- **Receiving DOES increment `quantityOnHand`.** Multiple partial receipts per PO
  are normal and expected.
- `discrepancy` (`receivedQuantity − orderedQuantity`) is computed and **never
  blocks** — over- and under-delivery are both accepted and reported.
- Receipts are **immutable**: no PATCH, no DELETE. Correct a mistake with
  `PATCH /inventory-items/:itemId { quantityOnHand }`.

### Wastage

`POST /wastage-logs` — `{ wastedAt?, notes?, items: [{ inventoryItemId,
quantityWasted, reason, notes? }] }`.
`reason` ∈ `spoiled, damaged, expired, prep_error, other`.

- **Reading *and* logging need only `view_inventory`** — so a Chef can log wastage
  without `manage_inventory`. This is deliberate.
- **Wasting more than current stock is rejected with 409.** Deliberately unlike sale
  deduction, which is allowed to go negative.
- Immutable — no PATCH, no DELETE.

### Health & safety scans — `/api/shops/:shopId/inventory-scans`

Gated on **`perform_health_safety`**, which Manager, Shift Manager, Server **and**
Chef all hold by default — expiry labelling is floor-staff work, not stock
management. That is exactly why these responses **omit `quantityOnHand` and
`lowStockThreshold`**: `view_inventory` data must not leak through the wider gate.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /` | `{ sku, state: 'sealed' \| 'opened' }` | Looks the item up by SKU, picks `shelfLifeDays` or `shelfLifeOpenedDays` per `state`, computes `expiresOn = today + days`, writes an immutable row. **400 if that shelf life is not configured** |
| `GET /` | — | Every scan |
| `GET /latest` | — | One row per item — its **most recent** scan only. Items never scanned are absent |
| `GET /expired` | — | Items whose **latest** scan has passed `expiresOn` with no resolution yet |
| `GET /:scanId` | — | |
| `POST /:scanId/print` | — | **201.** Each call writes a **new** print row — reprinting a damaged label is normal. Returns a narrow `{ label: { itemName, sku, expiresOn } }` |
| `GET /:scanId/prints` | — | Print history |
| `POST /:scanId/resolve` | `{ wastageLogId?, notes? }` | **400** if the scan has not expired; **409** if already resolved |
| `GET /:scanId/resolution` | — | |

**Flagging is flag-only — resolving never creates a wastage log or moves stock.**
There is no per-batch quantity anywhere in this system, so there is no quantity the
API could correctly guess. `wastageLogId` is **optional**: a flag closes either by
pointing at a real wastage log (validated to belong to this shop *and* to cover this
scan's item) or by plain dismissal — false alarm, already used, mis-scanned.

`GET /latest` and `GET /expired` are registered before `/:scanId`; the literal
segments always win.

---

## 7. Till

Gated on **`access_till`**, with three exceptions: both discount routes and the
refund route need **`apply_discount`**, and the item-status route needs
**`view_kds`**.

### Create an order — `POST /api/shops/:shopId/orders`

```jsonc
{
  "type": "dine_in" | "takeaway",
  "tableNumber": "12",        // REQUIRED iff dine_in; REJECTED for takeaway
  "customerName": "Sam",      // always optional
  "items": [                  // at least one, always
    {
      "menuItemId": "uuid",   // exactly ONE of menuItemId / shopMenuItemId
      "shopMenuItemId": "uuid",
      "variantId": "uuid",    // optional
      "modifierOptionIds": ["uuid"],
      "quantity": 2           // positive integer
    }
  ]
}
```

Returns **201** with the full order detail. There is no empty-order-then-add-items
flow; header and lines are created together.

**Rules the client should pre-enforce for UX** (the server enforces them regardless):

- **Never send a price.** Prices are resolved server-side from the shop's resolved
  menu.
- A disabled (86'd) item or variant is rejected.
- **`minSelections` / `maxSelections` are enforced on every attached modifier
  group** — including groups the customer never touched. Zero selections fails a
  `minSelections > 0` group.
- `unitPrice` and each modifier's `priceDelta` are **snapshotted**. Later menu price
  changes never alter a placed order.
- Item, variant and modifier **names are not snapshotted** — they are joined live at
  read time, so renaming a menu item retroactively changes how old orders read.

**Add items:** `POST /:orderId/items { items: [ …same shape… ] }`. Requires the
order to still be `open`.

### Order lifecycle

```
open ──payment──▶ partially_paid ──payment──▶ paid
 │                      │                      │
 │                      └──────refund──────────┤
 cancel                                        ▼
 │                              partially_refunded ⇄ refunded
 ▼
cancelled
```

**The first payment LOCKS the order.** Status leaves `open`, and add-items,
discounts, cancel and void all stop being accepted. **Once any refund is issued the
order accepts no further payment** — a partially paid order that is then refunded
cannot be topped up; settle it as a new order.

### Discounts

`PATCH /:orderId/discount` (order-level) and
`PATCH /:orderId/items/:orderItemId/discount` (per line).

- **Set:** `{ discountType: 'percentage' | 'fixed', discountValue: number > 0, reason? }`
  — percentage capped at 100.
- **Clear:** `{ discountType: null, discountValue: null }` — **both null together**.
- The order-level discount applies to the subtotal **after** all per-line discounts.
- A `fixed` discount exceeding what it applies against is **rejected (400)** at apply
  time.
- Discounting an **already-voided** line is rejected (400).
- Both require `status === 'open'`.

### Cancel & void

`POST /:orderId/cancel` and `POST /:orderId/items/:orderItemId/void`, both
`{ wasPrepped: boolean, reason? }` → **200** with the full order detail.

- **`wasPrepped` is required and never defaulted** — staff declare it explicitly, so
  the UI needs a deliberate yes/no control, not a silent default.
- Both require `status === 'open'`. There is **no un-cancel and no un-void**.
- **Voiding the last remaining active line is rejected (400)** — "cancel the order
  instead".
- Voided items **stay in the `items` array** for audit but are excluded from every
  total. **Render them struck through.**
- **Cancelling does not zero the totals.** `status` and `cancellation` are the
  authoritative "not charged" signal; the totals remain a record of what the order
  contained.
- **Neither creates a wastage log nor reverses inventory.** If stock was already
  deducted, it stays deducted.

### Item prep status — `PATCH /:orderId/items/:orderItemId/status`

`{ "status": "pending" | "in_progress" | "ready" | "served" }` — **`view_kds`**, not
`access_till`.

- **Transitions are unrestricted** — forward, backward, or skipping ahead. A mis-tap
  can be corrected, deliberately unlike `order.status`.
- Blocked only by a **cancelled order** (400) or an **already-voided item** (400).
  A **paid** order still accepts status changes — payment does not stop the kitchen.
- **Returns the KDS-narrowed view ([§8](#8-kitchen-display)), not the full order
  detail.** No money comes back from this route.

> **Reaching `ready` — or `served`, the skip-ahead backstop — fires the inventory
> deduction.** Exactly once per line ever, guarded by an atomic claim, so
> re-entering the status never double-deducts. **It is not reversible**: a mis-tap
> onto `ready` moves real stock, correctable only through a manual `quantityOnHand`
> PATCH or a wastage entry. **Consider a confirm step in the KDS UI.**

### Payments — `POST /:orderId/payments`

A **discriminated union on `method`** — the required field differs by method:

```jsonc
{ "method": "cash", "amountTendered": 20.00 }   // MAY exceed the balance
{ "method": "card", "amount": 15.50 }           // may NOT exceed the balance
```

- **Split and partial payment is simply calling this more than once.**
- Cash credits `min(amountTendered, balanceDue)` and derives `change`. A card charge
  over the balance is **rejected (400)** — there is nothing to give change from.
- A **declined card returns 402** with **zero payment rows written** and the order
  untouched. Show the cashier the decline and let them retry or switch to cash.
- Payments are **immutable** — no PATCH, no DELETE. Correcting one is a refund.

> **Known edge case:** an order whose total is **£0** (e.g. a 100% discount) cannot
> be marked paid — a payment against it is rejected as "no outstanding balance", and
> it stays `open` forever. Handle this in the UI.

### Refunds — `POST /:orderId/payments/:paymentId/refund`

`{ amount: number > 0, reason? }` → **201**.

- A refund targets **one payment**, not the order — a card refund must reverse that
  specific charge's `providerReference`.
- **Partial refunds are calling this more than once** against the same payment.
- **No `method` field** — it is always the parent payment's, so you cannot refund a
  card payment as cash.
- Over-refunding beyond that payment's remaining refundable balance (its `netAmount`)
  is **rejected (400)**.
- A declined card refund returns **402** with zero rows written.

### Offline sync — `POST /api/shops/:shopId/orders/sync`

An idempotent queue of sales the till rang up **and took payment for** while offline.

```jsonc
{
  "clientOrderId": "device-local-id",       // 1–200 chars, any format
  "occurredAt": "2026-09-05T18:30:00.000Z", // ISO 8601 WITH offset, required
  "type": "dine_in" | "takeaway",
  "tableNumber": "…", "customerName": "…",
  "items": [{
    "menuItemId": "uuid",                   // or shopMenuItemId
    "variantId": "uuid",
    "quantity": 1,
    "unitPrice": 8.50,                      // REQUIRED — what was actually charged
    "modifiers": [{ "modifierOptionId": "uuid", "priceDelta": 0.5 }]
  }],
  "payment": { "method": "cash", "amountTendered": 10 }   // REQUIRED
}
```

**The status codes are the whole contract:**

| Code | Meaning | What the till should do |
|---|---|---|
| **201** | First sync — order created | Remove from the queue |
| **200** | Replay — same key, same payload. The original order is returned, nothing written | Remove from the queue |
| **409** | Same key, **different** payload | **Do not retry blindly** — this is a real key collision |
| 400 | `platform`-mode card sale, or card over total | Cannot be synced as-is |
| 404 | Item / variant / modifier not in this shop's menu (including soft-deleted) | Cannot be synced |

- **Client-snapshotted prices are trusted as historical fact.** The cash is already
  in the drawer at the price the customer was charged, so the server does **not**
  re-price, does **not** check `isEnabled` (an item 86'd after the sale still syncs),
  and does **not** re-enforce modifier min/max.
- What *is* enforced is tenancy and referential integrity: the item must exist in
  **this** shop's menu, and any variant or modifier option must genuinely belong to
  that item.
- **Payment scope: cash always; card only when the company is in `own`
  `cardPaymentMode`.** A `platform` card sale is **400** — our provider must be
  reached live to authorise a card, so a queued one could not legitimately exist.
- `payment` is **required**. An offline order with nothing charged has no reason to
  be queued; ring it up normally once connectivity returns.
- A synced order is **locked exactly like a paid online order**.
- **It does not push to the KDS** — it is a historical record of food already made,
  not new kitchen work.
- Rejections write nothing and leave the `clientOrderId` free to retry.
- Normalise your payload the same way each time. The server hashes a canonical form,
  so `10` vs `10.00` and `…T18:30:00.000Z` vs `…T19:30:00+01:00` correctly replay as
  200 rather than colliding as 409.

### Order detail response

Returned by `GET /:orderId` **and by every write's 200/201**.

```jsonc
{
  "id", "shopId", "type", "tableNumber", "customerName",
  "status": "open"|"cancelled"|"partially_paid"|"paid"|"partially_refunded"|"refunded",
  "createdByActorType", "createdByActorId",
  "orderNumber": 42,          // per-shop, per-day, human-readable. null on legacy orders
  "orderDate": "2026-09-06",  // a DATE string, not a timestamp

  "items": [{                 // includes voided lines, for audit
    "id", "menuItemId", "shopMenuItemId", "variantId",
    "itemName", "variantName",   // joined live, NOT snapshotted
    "quantity", "unitPrice",     // unitPrice IS snapshotted
    "modifiers": [{ "id", "modifierOptionId", "name", "priceDelta" }],
    "lineTotal",                 // PRE-discount
    "discount": null | { type, value, reason, appliedByActorType, appliedByActorId, appliedAt },
    "total",                     // POST-discount
    "void": null | { voidedAt, voidedByActorType, voidedByActorId, reason, wasPrepped },
    "status": "pending"|"in_progress"|"ready"|"served",
    "statusUpdatedAt", "statusUpdatedByActorType", "statusUpdatedByActorId",
    "createdAt"
  }],

  "subtotal",            // pre-discount, ACTIVE items only, VAT-INCLUSIVE
  "itemDiscountTotal",
  "discount": null | { … },
  "discountAmount",
  "total",               // VAT-INCLUSIVE, floored at 0

  "vatRate",             // null on pre-VAT orders — an honest "never calculated"
  "vatExclusiveAmount",  // NOT called netAmount — that name is taken below
  "vatAmount",           // total − vatExclusiveAmount, reconciles EXACTLY

  "cancellation": null | { cancelledAt, cancelledByActorType, cancelledByActorId, reason, wasPrepped },

  "payments": [{
    "id", "method", "amount",
    "amountTendered",    // cash only, else null
    "change",            // derived, cash only, else null
    "providerReference", // null for cash AND for 'own' card mode
    "paidByActorType", "paidByActorId",
    "refunds": [{ "id", "amount", "reason", "providerReference",
                  "refundedByActorType", "refundedByActorId", "createdAt" }],
    "amountRefunded",
    "netAmount",         // still REFUNDABLE against this payment
    "createdAt"
  }],
  "amountPaid",          // GROSS — every payment ever, ignoring refunds
  "amountRefunded",
  "netAmountPaid",
  "balanceDue",          // total − netAmountPaid, floored at 0

  "clientOrderId", "occurredAt",   // null unless offline-synced
  "createdAt", "updatedAt"
}
```

### Order list response — `GET /`

`{ id, shopId, type, tableNumber, customerName, status, createdByActorType,
createdByActorId, itemCount, orderNumber, orderDate, clientOrderId, occurredAt,
createdAt, updatedAt }`

**No items and no money at all.** Fetch the detail for totals.

---

## 8. Kitchen display

```
GET wss://pos-api-52vj.onrender.com/api/shops/:shopId/kds/socket
Authorization: Bearer <owner JWT | staff session token>
```

- **The same `Authorization` header as REST** — deliberately not a query-string
  token, so it stays out of any log that captures the request line.
- Gated on **`view_kds`**.
- A refused handshake gets a **real HTTP response** (401 / 403 / 404) with the
  standard error envelope — not a socket that opens and immediately closes.

> **Browsers cannot set headers on `new WebSocket(...)`.** The Android/iOS KDS
> clients set it directly. A browser-based KDS needs a proxy that injects the
> header — there is no query-string fallback.

**Re-authorization.** Every live socket is re-checked on a **30-second heartbeat**.
Deactivation, logout, session expiry, role change and a withdrawn override all
disconnect the socket within ~30s. It fails **closed** on revoked auth and **open**
on an infrastructure error, so a database blip cannot black out every kitchen. A
connected KDS keeps its staff session alive.

**Server → client messages** — all JSON, all carrying `at`:

| `type` | Payload |
|---|---|
| `kds.connected` | `{ shopId, actor: { type, id }, at }` — authenticated **and** authorized |
| `kds.unauthorized` | `{ statusCode, message, at }` — sent immediately before the server closes a revoked socket |
| `order.created` | `{ shopId, order: <KDS view>, at }` |
| `order.items_added` | same |
| `order.cancelled` | same |
| `order.item_voided` | same |
| `order.item_status_changed` | same — echoes the kitchen's own progress to every other screen in the shop |

Close codes: **4401** unauthenticated · **4403** forbidden · **4404** not found.

### The KDS order view

An **allow-list projection** with every monetary field removed. Also the return
shape of the item-status PATCH.

```jsonc
{
  "id", "shopId",
  "orderNumber", "orderDate",   // what the kitchen actually calls the ticket
  "type", "tableNumber", "customerName",
  "status",                     // business/payment state — so the kitchen knows to stop
  "kitchenStatus",              // DERIVED: lowest item status across non-voided lines
  "items": [{
    "id", "menuItemId", "shopMenuItemId", "variantId",
    "itemName", "variantName", "quantity",
    "modifiers": [{ "id", "modifierOptionId", "name" }],   // no priceDelta
    "status", "statusUpdatedAt", "statusUpdatedByActorType", "statusUpdatedByActorId",
    "void", "createdAt"
  }],
  "cancellation", "occurredAt", "createdAt", "updatedAt"
}
```

**Absent by design:** `subtotal`, `itemDiscountTotal`, `discount`, `discountAmount`,
`total`, `vatRate`, `vatExclusiveAmount`, `vatAmount`, `payments`, `amountPaid`,
`amountRefunded`, `netAmountPaid`, `balanceDue`, per-item
`unitPrice`/`lineTotal`/`discount`/`total`, and per-modifier `priceDelta`.

**Two different status fields, deliberately:**

- `status` — the payment/business state of the order.
- `kitchenStatus` — the **lowest** item status across non-voided lines, so a ticket
  only reads `ready` once **every** line is, and voided lines cannot hold it back.
  `null` if nothing is active.

**Reconnection: there is no replay or backfill.** On connect and on every reconnect,
fetch `GET /api/shops/:shopId/orders` to hydrate, then apply socket events on top.

> **The connection registry is in-memory and per-process.** Correct for the single
> production instance today, but it would not fan out across multiple instances if
> the service is ever scaled.

---

## 9. Cross-cutting rules

### Nullable fields — "explicit null clears, omitted leaves untouched"

This governs **every** nullable field in the API: `lowStockThreshold`,
`shelfLifeDays`, `shelfLifeOpenedDays`, `sku`, and both discount fields.

A PATCH form must distinguish **three** states:

| Intent | Send |
|---|---|
| Leave untouched | **omit the key entirely** |
| Clear the value | `null` |
| Set the value | the value |

An empty string or `undefined` is **not** a clear. Build **one** shared form helper
for this and use it everywhere — this is the single most likely source of silent
data bugs in the frontend. For discounts, `discountType` and `discountValue` must be
null **together**.

### Money — never re-derive it client-side

The API is the one definition of every total, and they reconcile exactly by
construction. Render what it returns. Never sum `items` yourself, never re-round,
never compute a third amount from two the API already gives you.

- **`total` is VAT-INCLUSIVE.** `vatAmount` is decomposed *out of* it, never added on
  top. Nothing the customer pays changes because of VAT.
- **`vatRate: null` means "this order predates VAT calculation"** — render it as
  "not calculated", **never as 0%**. `0` is a real and different value.
- `vatRate` is **snapshotted at creation** and never tracks later shop-settings
  changes.
- `lineTotal` is **pre**-discount; `item.total` is **post**-discount.
- `amountPaid` is **gross**; `netAmountPaid` nets off refunds; `balanceDue` uses the
  **net**.
- **`payment.netAmount` = still refundable against that payment.
  `order.vatExclusiveAmount` = net of VAT.** Two entirely different things, at two
  nesting levels of the same response, deliberately given two names — do not
  conflate them in a shared formatter.
- Voided items stay in `items` but are excluded from every total.
- **One shop-level VAT rate applies to the whole order.** Mixed-rate baskets — hot
  food alongside a zero-rated cold drink — are **not supported**.

### Dates — calendar strings are not instants

| Field | Kind | Handling |
|---|---|---|
| `orderDate`, `expiresOn` | **calendar date** `YYYY-MM-DD` | **Render as a plain string** |
| `createdAt`, `updatedAt`, `occurredAt`, `scannedAt` | real instants | Safe to localize |

Running a calendar date through `new Date(...).toISOString()` shifts it a day for
negative-offset users. This exact trap already bit the backend once.

**"Today" is UTC throughout the API.** There is no per-shop timezone column
anywhere, so order numbering resets at **midnight UTC**, not at close of trade —
2am during BST. Do not localize it and imply otherwise.

### What is snapshotted vs. joined live

| Snapshotted at write time | Joined live at read time |
|---|---|
| `unitPrice`, modifier `priceDelta` | item, variant and modifier **names** |
| `vatRate` | |

So a renamed menu item retroactively changes how old orders read, but a re-priced
one does not.

### Immutability

Receipts, wastage logs, scans, prints, resolutions, payments and refunds are all
**immutable** — no PATCH, no DELETE anywhere. Corrections go through a *new* record
or the resource's own manual endpoint, never a reversal. Build the UI accordingly:
confirm-before-submit, not edit-after-the-fact.

---

## 10. Traps

Ranked by how much time each will cost you.

1. **One token slot for both auth systems.** Owner JWT and staff session both ride
   `Authorization: Bearer` and look identical on the wire. Separate storage keys,
   separate contexts.
2. **Concurrent refreshes log the user out.** Rotation invalidates the token you
   sent. One in-flight refresh promise, always.
3. **Gating UI on permission alone cripples the owner**, who bypasses the permission
   system entirely. Branch on actor type first.
4. **404 means "not found *or* not yours".** Never render "deleted".
5. **`source: "master"` → `menuItemId`; `source: "local"` → `shopMenuItemId`.**
   Exactly one, never both.
6. **A `ready` tap moves real stock, irreversibly.** Confirm it.
7. **A Chef cannot call the orders REST endpoints** — no `access_till`. Use the
   socket and the status PATCH.
8. **`GET /attendance` silently narrows** to your own records without `manage_rota`;
   `GET /attendance/:recordId` **403s** instead. Do not show a staff filter to users
   without the permission.
9. **An owner cannot clock in** — 400, not 403.
10. **Every rota route 400s when `rotaEnabled` is false.** Hide the section.
11. **`kdsEnabled` and the `health_safety` add-on are NOT enforced by the API.**
    `rotaEnabled` is. If the product intends those to gate access, the frontend must
    do it.
12. **A £0 order can never be marked paid** and stays `open` forever.
13. **Unlinked ingredients silently skip deduction** with no error. Surface them as
    a setup warning.
14. **Offline sync 409 means a real key collision** — never retry it blindly.
15. **Calendar dates are strings.** `toISOString()` will shift them a day.
16. **Free-tier spin-down** drops every KDS socket after ~15 minutes idle. Reconnect
    and re-hydrate.

---

## 11. Not built yet

Do not design around these — they do not exist.

- **Module 11 — Loyalty / rewards:** program config, phone-based customer lookup,
  earn and redeem, chain-wide points.
- **Module 12 — Reporting:** sales, purchase and wastage, best/least-selling, custom
  date ranges, PDF export, chain consolidated view.
  **`view_reports` exists as a permission but nothing checks it yet.**
- **Module 13 — Real payment provider:** card processing today goes through a
  vendor-agnostic stub that touches no network in **any** environment. The
  `{ success, providerReference, failureReason }` contract will not change when a
  real SDK lands, so nothing on the frontend should need to.

There is also **no transaction wrapper anywhere in the backend**, which is why
several flows above are one-directional and correction happens through new records
rather than edits. Expect that shape to continue.

# EzPOS API — Complete Endpoint Reference

Generated from the actual route files on branch `master` (Modules 0–10 complete).
This is the contract the Next.js frontend builds against.

---

## 0. Global conventions

**Base URL**
- Local: `http://localhost:<PORT>`
- Production: your Render service URL.
- Every path below is absolute from the base URL.

**Content type:** `application/json` everywhere (the one exception is
`POST /api/webhooks/stripe`, which Stripe calls, not the frontend).

**Error envelope — every non-2xx response, no exceptions:**
```json
{ "error": { "message": "Human-readable message" } }
```
There is no `code`, no `fields[]`, no `details`. Validation failures come back as a
single 400 with every issue joined into one string, e.g.
`"Invalid request body - items.0.quantity: quantity must be greater than 0; type: Invalid enum value"`.
Never show that raw string to an end user — map on status code and, where you need
field-level UI, validate client-side first with a mirror of the server schema.

**Status codes used**
| Code | Meaning in this API |
|---|---|
| 200 | OK |
| 201 | Created (also: order sync's *first* call) |
| 400 | Validation failure, or a business rule refusing the action (over-discount, over-refund, wasting more than stock, expired-scan rules, cancelled-order guards) |
| 401 | Missing/invalid/expired token (owner JWT or staff session) |
| 402 | Billing locked (`requireActiveBilling`), **and** a declined card payment/refund |
| 403 | Authenticated but lacks the required permission, or outranked by the target staff member |
| 404 | Not found **or out of the actor's tenancy scope** — a shop in another company returns 404, never 403 |
| 409 | Conflict (duplicate SKU, already-resolved scan, offline-sync payload mismatch, insufficient stock on wastage) |
| 429 | Rate limited |
| 500 | Internal error — message is always the literal `"Internal server error"` |

**Tenancy is enforced by 404.** Requesting a shop/order/item outside the actor's
company or shop returns 404, not 403. The frontend must not treat 404 as "deleted".

**Rate limits**
- Global: 300 requests / 15 min per client IP.
- `POST /api/staff-auth/login`: 10 attempts / 15 min, keyed by *(IP, shopId)*.

**CORS:** the deployed origin must be listed in the API's `CORS_ALLOWED_ORIGINS`
env var. `credentials: true` is set, but this API uses **bearer tokens, not cookies**.

---

## 1. Authentication — two entirely separate systems

There are two kinds of caller and they are **not interchangeable**.

### Owner (the dashboard user)
- `Authorization: Bearer <accessToken>` — a **JWT, 15 minutes**.
- Refreshed with an opaque, **rotating**, server-stored refresh token.
- Rotation means: each `POST /api/auth/refresh` invalidates the token you sent and
  returns a new one. Two concurrent refreshes will make one of them fail — the
  frontend must serialize refreshes (single in-flight promise).

### Staff (till / KDS user)
- `Authorization: Bearer <sessionToken>` — an **opaque DB-stored token**, sliding
  **60-minute** window (any authenticated request extends it).
- Obtained by 8-digit `staffIdCode` + 8-digit `pin` against a specific `shopId`.
- There is **no refresh endpoint** for staff. When the session expires, re-PIN-in.

### Which token does a route accept?
| Middleware | Accepts | Routes |
|---|---|---|
| `requireAuth` | Owner JWT **only** | `/api/me`, `/api/companies/*` (incl. master menu + inventory-overview), `/api/shops` CRUD + addons |
| `requireStaffOrOwnerAuth` | **Either**, on the same `Authorization` header | every `/api/shops/:shopId/<resource>` route, and `/api/staff-permissions` |
| none | — | `/api/auth/*`, `/api/staff-auth/*`, `/api/webhooks/stripe`, `/health` |

`requireStaffOrOwnerAuth` sets `req.actor = { type: 'owner' | 'staff', id, ... }`.
An **owner bypasses the permission system entirely** — every permission check below
applies only to staff actors.

---

## 2. Roles & permissions

**Roles:** `owner`, `manager`, `shift_manager`, `server`, `chef`
(`owner` is not a staff role — it is the account holder).

**Rank (for staff management):** owner 4 > manager 3 > shift_manager 2 > server 1 = chef 1.
A staff member may only create/edit/deactivate someone **strictly below** their own
rank. This is why "a Manager cannot create another Manager" needs no special case.

**Permissions (13):**
`view_inventory`, `manage_inventory`, `request_stock_order`, `manage_stock_orders`,
`manage_staff`, `access_till`, `perform_health_safety`, `grant_permissions`,
`view_reports`, `manage_rota`, `manage_menu`, `apply_discount`, `view_kds`

**Defaults per role:**

| Permission | Manager | Shift Mgr | Server | Chef |
|---|:--:|:--:|:--:|:--:|
| view_inventory | ✅ | | | ✅ |
| manage_inventory | ✅ | | | |
| request_stock_order | | | | ✅ |
| manage_stock_orders | ✅ | | | |
| manage_staff | ✅ | | | |
| access_till | ✅ | ✅ | ✅ | |
| perform_health_safety | ✅ | ✅ | ✅ | ✅ |
| grant_permissions | ✅ | | | |
| manage_rota | ✅ | | | |
| manage_menu | ✅ | | | |
| apply_discount | ✅ | ✅ | | |
| view_kds | ✅ | ✅ | | ✅ |
| view_reports | | | | |

`view_reports` has no default holder and nothing checks it yet (Module 12).

**Overrides are additive only.** `POST /api/staff-permissions/:staffId` grants an
extra permission to one person; there is no deny-list. So the effective set is
`role defaults ∪ active overrides`.

**The Chef/till split is load-bearing.** The Chef is the KDS's primary user and has
**no `access_till`** — so `GET /api/shops/:id/orders/:orderId` correctly 403s them.
The KDS gets a *narrowed* order payload (see §14) with every monetary field stripped.

---

## 3. Health

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |

200 `{ status, db, environment, timestamp }` · 503 if the DB is unreachable.

---

## 4. Owner auth — `/api/auth` (no auth required)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/register` | `{ email, password (min 10), fullName }` | 201 `{ message, user: { id, email, fullName } }` |
| POST | `/verify-email` | `{ token }` | 200 `{ message }` |
| POST | `/resend-verification` | `{ email }` | 200 `{ message }` (always the same message — no account enumeration) |
| POST | `/login` | `{ email, password }` | 200 `{ accessToken, refreshToken, user: { id, email } }` |
| POST | `/refresh` | `{ refreshToken }` | 200 `{ accessToken, refreshToken }` (**rotated**) |
| POST | `/logout` | `{ refreshToken }` | 200 `{ message }` (no-op on an unknown token) |
| POST | `/forgot-password` | `{ email }` | 200 `{ message }` (always identical) |
| POST | `/reset-password` | `{ token, newPassword (min 10) }` | 200 `{ message }` |
| POST | `/confirm-email-change` | `{ token }` | 200 `{ message, email }` |

**Email link landing pages the frontend MUST provide** (the API builds these URLs
from its `FRONTEND_URL` env var):
- `/verify-email?token=…`
- `/reset-password?token=…`
- `/confirm-email-change?token=…`
- `/billing` (linked from billing failure emails)

---

## 5. Owner profile — `/api/me` (owner JWT)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/` | — | `{ id, email, fullName, emailVerified, pendingEmail }` |
| PATCH | `/` | `{ fullName }` | same shape |
| POST | `/change-password` | `{ currentPassword, newPassword }` | `{ message }` |
| POST | `/change-email` | `{ currentPassword, newEmail }` | `{ message }` — sets `pendingEmail`; a confirmation email completes it |

---

## 6. Staff auth — `/api/staff-auth` (no auth required)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/login` | `{ shopId (uuid), staffIdCode (8 digits), pin (8 digits) }` | `{ sessionToken, staff: { id, fullName, role, shopId } }` |
| POST | `/logout` | `{ sessionToken }` | `{ message }` |

Login also fails if the company's billing is locked. Rate limited to 10 / 15 min
per (IP, shop) — surface the 429 as "too many attempts, try again shortly", and
**do not auto-retry**.

---

## 7. Company — `/api/companies` (owner JWT)

| Method | Path | Body / Query | Notes |
|---|---|---|---|
| POST | `/` | `{ name, addressLine1, addressLine2?, city, postcode, country, phone, vatNumber?, companyNumber? }` | One company per owner. Grants the one-time trial. |
| GET | `/mine` | — | Company object (below) |
| PATCH | `/mine` | any subset of the create fields | **Cannot** set `businessType` or `cardPaymentMode` |
| DELETE | `/mine` | — | Soft delete |
| POST | `/mine/business-type` | `{ businessType: 'single' \| 'chain' }` | Dedicated action — an onboarding decision |
| POST | `/mine/card-payment-mode` | `{ cardPaymentMode: 'platform' \| 'own' }` | Dedicated action — decides how money is taken |
| GET | `/mine/billing-history` | `?limit=1..100` (default 10) | `{ invoices: [...], hasMore }` — Stripe invoices; **not** billing-gated |

**Company response object**
```jsonc
{
  "id", "name", "addressLine1", "addressLine2", "city", "postcode", "country",
  "phone", "vatNumber", "companyNumber",
  "businessType": "single" | "chain" | null,   // null until set — drive onboarding off this
  "cardPaymentMode": "platform" | "own",       // never null, defaults to "platform"
  "trialEndsAt", "subscriptionStatus", "gracePeriodEndsAt",
  "createdAt", "updatedAt"
}
```

**Billing lock.** When billing lapses past the grace period, `requireActiveBilling`
returns **402** on the billing-gated routes only:
`POST /api/shops` and `POST /api/shops/:shopId/addons`. Staff PIN login also fails.
Everything else — viewing, editing, closing shops, and billing history — stays open
so the owner can see and reduce their bill. Derive the "locked" banner from
`subscriptionStatus` + `gracePeriodEndsAt`; the API does not return an
`isBillingLocked` flag.

**`cardPaymentMode` semantics**
- `platform` — card payments go through our provider; the payment row gets a
  `providerReference`; a declined card returns **402**.
- `own` — the shop uses its own terminal. The till still records
  `method: "card"` with full card semantics (fixed amount, capped at the balance,
  no over-tender/change), but **no provider is called** and `providerReference` is
  `null`. Refunds key off the *payment's own* `providerReference`, never the
  company's current mode.

---

## 8. Master menu — `/api/companies/mine/…` (owner JWT only)

Company-level master data. **Staff cannot reach these routes at all** — staff work
against the resolved shop menu in §12.

**Categories**
| Method | Path |
|---|---|
| POST | `/menu-categories` — `{ name, displayOrder? }` |
| GET | `/menu-categories` |
| PATCH | `/menu-categories/:categoryId` — `{ name?, displayOrder?, isActive? }` |
| DELETE | `/menu-categories/:categoryId` |

**Items**
| Method | Path |
|---|---|
| POST | `/menu-items` — `{ categoryId, name, description?, price, displayOrder? }` |
| GET | `/menu-items?categoryId=` |
| GET | `/menu-items/:itemId` |
| PATCH | `/menu-items/:itemId` |
| DELETE | `/menu-items/:itemId` |

**Size variants** (a variant price is **absolute** — it *replaces* the item price)
| Method | Path |
|---|---|
| POST | `/menu-items/:itemId/variants` — `{ name, price, displayOrder? }` |
| GET | `/menu-items/:itemId/variants` |
| PATCH | `/menu-items/:itemId/variants/:variantId` |
| DELETE | `/menu-items/:itemId/variants/:variantId` |

**Modifier groups & options** (an option `priceDelta` is **additive**, may be negative)
| Method | Path |
|---|---|
| POST | `/modifier-groups` — `{ name, minSelections?, maxSelections? }` |
| GET | `/modifier-groups` |
| PATCH · DELETE | `/modifier-groups/:groupId` |
| POST | `/modifier-groups/:groupId/options` — `{ name, priceDelta?, displayOrder? }` |
| GET | `/modifier-groups/:groupId/options` |
| PATCH · DELETE | `/modifier-groups/:groupId/options/:optionId` |
| POST · DELETE | `/menu-items/:itemId/modifier-groups/:groupId` (attach/detach, no body) |
| GET | `/menu-items/:itemId/modifier-groups` |

**Ingredients & allergens**
| Method | Path |
|---|---|
| POST | `/ingredients` — `{ name, unit, allergens?: Allergen[] }` |
| GET | `/ingredients` |
| PATCH · DELETE | `/ingredients/:ingredientId` |

`Allergen` ∈ `celery, gluten, crustaceans, eggs, fish, lupin, milk, molluscs,
mustard, tree_nuts, peanuts, sesame, soybeans, sulphites` (UK 14).

**Recipes** — all three take `{ quantity: number > 0 }` on POST/PATCH:
| Level | Paths |
|---|---|
| Item | `POST·PATCH·DELETE /menu-items/:itemId/ingredients/:ingredientId` · `GET /menu-items/:itemId/ingredients` |
| Variant | `POST·PATCH·DELETE /menu-items/:itemId/variants/:variantId/ingredients/:ingredientId` · `GET …/ingredients` |
| Modifier option | `POST·PATCH·DELETE /modifier-groups/:groupId/options/:optionId/ingredients/:ingredientId` · `GET …/ingredients` |

**Recipes sum ADDITIVELY** across base item + variant + modifiers — deliberately the
opposite shape from pricing, where a variant price *replaces* the item's. A variant
recipe lists only the **extra** over the base.

---

## 9. Cross-shop inventory overview

| Method | Path | Auth |
|---|---|---|
| GET | `/api/companies/mine/inventory-overview?lowStockOnly=true` | **Owner JWT only** |

Flat list of every active inventory item across every active shop in the company,
each row tagged with `shopId` / `shopName`, plus computed `isLowStock`. Owner-only
because no staff role has cross-shop authority anywhere in this system.

---

## 10. Shops — `/api/shops` (owner JWT)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/` | `{ name, addressLine1, addressLine2?, city, postcode, country, phone, kdsEnabled?, rotaEnabled?, vatRegistered, defaultVatRate? }` | **Billing-gated (402)** |
| GET | `/` | — | List |
| GET | `/:id` | — | |
| PATCH | `/:id` | partial of the above | |
| DELETE | `/:id` | — | Soft delete |

**Shop response:** `{ id, name, addressLine1, addressLine2, city, postcode, country,
phone, kdsEnabled, rotaEnabled, vatRegistered, defaultVatRate, createdAt, updatedAt }`

`vatRegistered` is **required** on create. `defaultVatRate` is 0–100. A shop with
`vatRegistered: true` and no `defaultVatRate` is treated as **0%** at order time —
the API will not block a sale over an owner's misconfiguration, so the *frontend*
should warn on the shop settings screen.

**Add-ons** (nested, owner JWT)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/:shopId/addons` | `{ addonType: 'health_safety' }` | **Billing-gated (402)** |
| GET | `/:shopId/addons` | — | |
| DELETE | `/:shopId/addons/:addonType` | — | |

`health_safety` is currently the only add-on type. Module 8's scan endpoints depend
on it being active.

---

## 11. Staff & permissions

### Staff — `/api/shops/:shopId/staff` (owner or staff)
Writes need **`manage_staff`** *and* strictly outranking the target. Reads are open
to any in-scope actor.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/` | `{ fullName, role: 'manager'\|'shift_manager'\|'server'\|'chef' }` | 201. **The response includes a one-time `pin`** |
| GET | `/` | — | List |
| GET | `/:staffId` | — | |
| PATCH | `/:staffId` | `{ fullName?, role? }` | |
| DELETE | `/:staffId` | — | Deactivate (soft) |

**Staff response:** `{ id, shopId, fullName, role, staffIdCode, createdAt, updatedAt }`
— plus `pin` **only on the 201 from POST**. The raw PIN is never retrievable again.
The frontend must show it once, prominently, with a copy/print affordance and an
explicit "you will not see this again" warning.

### Permission overrides — `/api/staff-permissions` (owner or staff)
Writes need **`grant_permissions`** and outranking the target.

| Method | Path | Body / Query |
|---|---|---|
| GET | `/shop/:shopId/audit-log` | `?limit=1..100` (default 10) |
| GET | `/:staffId` | — → effective permissions for that staff member |
| POST | `/:staffId` | `{ permission: <one of the 13> }` |
| DELETE | `/:staffId/:permission` | — |

Note the shape: `:staffId` alone, **no `:shopId` in the path** except on the audit log.

---

## 12. Rota — `/api/shops/:shopId/…` (owner or staff)

All three routers require **`manage_rota`** for mutations; reads are scope-checked.

### `rota-shifts`
| Method | Path | Body / Query |
|---|---|---|
| POST | `/` | `{ staffId, startTime, endTime, notes? }` (ISO datetimes; `endTime > startTime`) |
| GET | `/` | `?from=&to=` — **both required**, `to > from` |
| GET | `/:shiftId` | — |
| PATCH | `/:shiftId` | `{ staffId?, startTime?, endTime?, notes? }` |
| DELETE | `/:shiftId` | — |

### `swap-requests`
| Method | Path | Body / Query |
|---|---|---|
| POST | `/` | `{ shiftId, toStaffId, notes? }` |
| GET | `/` | `?status=pending\|approved\|rejected` (optional) |
| GET | `/:requestId` | — |
| POST | `/:requestId/approve` | no body |
| POST | `/:requestId/reject` | no body |

### `attendance`
| Method | Path | Body / Query |
|---|---|---|
| POST | `/clock-in` | no body — the actor clocks themselves in |
| POST | `/clock-out` | no body |
| GET | `/comparison` | `?from=&to=&staffId=` — rota vs. actual |
| GET | `/` | `?from=&to=&staffId=` |
| GET | `/:recordId` | — |

`from`/`to` are **required** on both list routes. Note `/comparison` is registered
before `/:recordId` — do not rely on any other ordering client-side.

---

## 13. Shop menu — `/api/shops/:shopId/menu` (owner or staff)

`GET /` is open to any in-scope actor. **Every mutation needs `manage_menu`.**

| Method | Path | Body |
|---|---|---|
| GET | `/` | — → **the resolved menu** (see below) |
| PATCH | `/overrides/:menuItemId` | `{ isEnabled?, priceOverride? }` |
| DELETE | `/overrides/:menuItemId` | — (clears the override) |
| PATCH | `/variants/:variantId` | `{ isEnabled?, priceOverride? }` |
| DELETE | `/variants/:variantId` | — |
| PATCH | `/modifier-options/:optionId` | `{ isEnabled?, priceDeltaOverride? }` |
| DELETE | `/modifier-options/:optionId` | — |
| POST | `/items` | `{ categoryId, name, description?, price, displayOrder? }` — a shop-**local** item |
| GET | `/items` | — |
| GET · PATCH · DELETE | `/items/:itemId` | |
| POST · DELETE | `/items/:itemId/modifier-groups/:groupId` | attach/detach |
| POST · PATCH · DELETE | `/items/:itemId/ingredients/:ingredientId` | `{ quantity }` |
| GET | `/items/:itemId/ingredients` | — |

**`GET /` — the resolved menu is THE endpoint the till renders from.** It already
applies every shop-level price/enabled override for items, variants *and* modifier
options. Never re-derive pricing on the client.

```jsonc
[
  {
    "id": "uuid",
    "source": "master" | "local",     // determines which id field you send on an order
    "categoryId": "uuid",
    "name": "…", "description": "…",
    "price": 8.5,                      // EFFECTIVE price (override applied)
    "masterPrice": 9.0,                // null for local items
    "isEnabled": true,                 // local items are always true
    "displayOrder": 1,
    "variants": [
      { "id", "name", "price", "masterPrice", "isEnabled", "displayOrder" }
    ],                                 // always [] for local items
    "modifierGroups": [ /* groups with minSelections/maxSelections and options */ ],
    "allergens": ["gluten", "milk"]    // aggregated from the recipe
  }
]
```

**Critical for ordering:** an item with `source: "master"` is ordered as
`menuItemId`; `source: "local"` is ordered as `shopMenuItemId`. Exactly one of the
two, never both.

---

## 14. Inventory — `/api/shops/:shopId/…` (owner or staff)

Reads need **`view_inventory`**, mutations **`manage_inventory`** — this includes
`GET`, unlike the menu. Stock is back-of-house.

### `inventory-items`
| Method | Path | Body / Query |
|---|---|---|
| POST | `/` | `{ name, unit, quantityOnHand?, lowStockThreshold?, shelfLifeDays?, shelfLifeOpenedDays?, sku? }` |
| GET | `/` | `?lowStockOnly=true` |
| GET | `/:itemId` | — |
| PATCH | `/:itemId` | same fields, all optional; `lowStockThreshold`, `shelfLifeDays`, `shelfLifeOpenedDays`, `sku` are **nullable** |
| DELETE | `/:itemId` | Soft delete |

**"Explicit null clears, omitted leaves untouched"** — this contract applies to
every nullable field in this API. A PATCH form must therefore distinguish "field
untouched" (omit it) from "field cleared" (send `null`). Sending `undefined`/`""`
is not the same thing.

`isLowStock` is computed at response time from `quantityOnHand` vs
`lowStockThreshold` — never sent by the client, never stored.
`sku` is unique **per shop** (409 on duplicate); the same barcode legitimately
recurs across shops in a chain.

### Item ↔ supplier links
| Method | Path | Body |
|---|---|---|
| POST | `/:itemId/suppliers/:supplierId` | `{ isDefault? }` |
| GET | `/:itemId/suppliers` | — |
| PATCH | `/:itemId/suppliers/:supplierId` | `{ isDefault: boolean }` |
| DELETE | `/:itemId/suppliers/:supplierId` | — |

At most one default supplier per item; setting a new one swaps atomically.

### Ingredient ↔ inventory-item links (the deduction bridge)
| Method | Path | Body |
|---|---|---|
| POST | `/:itemId/ingredient-links/:ingredientId` | `{ conversionFactor? }` |
| GET | `/:itemId/ingredient-links` | — |
| PATCH | `/:itemId/ingredient-links/:ingredientId` | `{ conversionFactor }` (required) |
| DELETE | `/:itemId/ingredient-links/:ingredientId` | — |

`conversionFactor` = inventory units per 1 ingredient unit (recipe in grams, stock
in 25 kg sacks). One link per `(shop, ingredient)`. **An ingredient with no link is
silently skipped at deduction time** — the frontend should surface unlinked
ingredients as a setup warning, because the API will not error on it.

### `suppliers`
`POST /` · `GET /` · `GET /:supplierId` · `PATCH /:supplierId` · `DELETE /:supplierId`
Body: `{ name, contactName?, phone?, email?, notes? }` (all but `name` optional).
Reads `view_inventory`, writes `manage_inventory`.

### `purchase-orders`
| Method | Path | Body | Permission |
|---|---|---|---|
| POST | `/` | `{ supplierId, orderedAt?, notes?, items: [{ inventoryItemId, quantity, unitCost? }] }` | `manage_inventory` |
| GET | `/` | — | `view_inventory` |
| GET | `/:poId` | — | `view_inventory` |
| DELETE | `/:poId` | — | `manage_inventory` |
| POST | `/:poId/receipts` | `{ receivedAt?, notes?, items: [{ purchaseOrderItemId, quantityReceived }] }` | `manage_inventory` |

- ≥1 line item required; **duplicate ids in one array are rejected (400)**.
- A PO is **logging only** — creating one does **not** move stock, and there is no
  status/workflow field.
- **Receiving DOES increment `quantityOnHand`.** Multiple partial receipts per PO
  are normal. `discrepancy` (`receivedQuantity − orderedQuantity`) is computed and
  **never blocks** — over- and under-delivery are both accepted and reported.
- Receipts are **immutable** — no PATCH, no DELETE. Correct a mistake via
  `PATCH /inventory-items/:itemId` `{ quantityOnHand }`.

### `wastage-logs`
| Method | Path | Body |
|---|---|---|
| POST | `/` | `{ wastedAt?, notes?, items: [{ inventoryItemId, quantityWasted, reason, notes? }] }` |
| GET | `/` | — |
| GET | `/:wastageLogId` | — |

**Both reading and logging need only `view_inventory`** — so a Chef can log wastage.
`reason` ∈ `spoiled, damaged, expired, prep_error, other`.
Wasting **more than current stock is rejected with 409** (deliberately unlike sale
deduction, which is allowed to go negative). Immutable — no PATCH/DELETE.

---

## 15. Health & Safety — `/api/shops/:shopId/inventory-scans`

Gated on **`perform_health_safety`** — which Manager, Shift Manager, Server **and**
Chef all hold by default. This is floor-staff work, not stock management, which is
why the responses here deliberately **omit `quantityOnHand` / `lowStockThreshold`**:
`view_inventory` data must not leak through this wider gate.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/` | `{ sku, state: 'sealed' \| 'opened' }` | Looks up the item by SKU, picks `shelfLifeDays` or `shelfLifeOpenedDays`, computes `expiresOn = today + days`, writes an immutable row. **400 if that shelf life isn't configured** |
| GET | `/` | — | All scans |
| GET | `/latest` | — | One row per item — its **most recent** scan only. Items never scanned are absent |
| GET | `/expired` | — | Items whose **latest** scan has passed `expiresOn` and has no resolution yet |
| GET | `/:scanId` | — | |
| POST | `/:scanId/print` | no body | 201. Each call is a **new print row** — reprinting is normal, not an error. Returns a narrow `{ label: { itemName, sku, expiresOn } }` |
| GET | `/:scanId/prints` | — | Print history |
| POST | `/:scanId/resolve` | `{ wastageLogId?, notes? }` | **400** if the scan hasn't expired; **409** if already resolved |
| GET | `/:scanId/resolution` | — | |

**Flagging is flag-only — resolving never creates a wastage log or moves stock.**
There is no per-batch quantity in this system, so there is no quantity the API could
correctly guess. `wastageLogId` is optional: a flag closes either by pointing at a
real 7.7 wastage log (validated to belong to this shop *and* to cover this scan's
item) or by plain dismissal.

**Dates:** `expiresOn` is a calendar **date** string (`YYYY-MM-DD`), not a timestamp.
Do **not** run it through `new Date().toISOString()` in the browser — you will land
on the previous day for negative-offset users. Render it as a plain string.

**"Today" is UTC** everywhere in this API. There is no per-shop timezone column.

---

## 16. Orders & till — `/api/shops/:shopId/orders`

Gated on **`access_till`**, with three exceptions:
- both discount routes and the refund route → **`apply_discount`**
- the item-status route → **`view_kds`**

There is **no DELETE anywhere**. Cancel, void and refund are explicit, one-directional
actions that create records; nothing is ever removed or reversed.

| Method | Path | Body | Perm |
|---|---|---|---|
| POST | `/` | create order (below) | `access_till` |
| GET | `/` | — | `access_till` |
| POST | `/sync` | offline sale (below) | `access_till` |
| GET | `/:orderId` | — | `access_till` |
| POST | `/:orderId/items` | `{ items: [...] }` | `access_till` |
| PATCH | `/:orderId/discount` | discount (below) | `apply_discount` |
| PATCH | `/:orderId/items/:orderItemId/discount` | discount | `apply_discount` |
| POST | `/:orderId/cancel` | `{ wasPrepped: boolean, reason? }` | `access_till` |
| POST | `/:orderId/items/:orderItemId/void` | `{ wasPrepped: boolean, reason? }` | `access_till` |
| PATCH | `/:orderId/items/:orderItemId/status` | `{ status }` | **`view_kds`** |
| POST | `/:orderId/payments` | payment (below) | `access_till` |
| POST | `/:orderId/payments/:paymentId/refund` | `{ amount, reason? }` | `apply_discount` |

### Create an order — `POST /`
```jsonc
{
  "type": "dine_in" | "takeaway",
  "tableNumber": "12",          // REQUIRED iff dine_in; REJECTED for takeaway
  "customerName": "Sam",        // always optional
  "items": [                    // at least one, always
    {
      "menuItemId": "uuid",     // exactly ONE of menuItemId / shopMenuItemId
      "shopMenuItemId": "uuid",
      "variantId": "uuid",      // optional
      "modifierOptionIds": ["uuid"],
      "quantity": 2             // positive integer
    }
  ]
}
```
Returns **201** with the full order detail. There is no empty-order-then-add-items
flow — header and lines are created together.

**Server-side rules the client should pre-enforce for UX:**
- prices are resolved server-side from the shop's resolved menu — never send a price;
- a disabled (86'd) item or variant is rejected;
- **`minSelections`/`maxSelections` on every attached modifier group are enforced**,
  including groups the customer never touched (0 selections fails a
  `minSelections > 0` group);
- `unitPrice` and each modifier's `priceDelta` are **snapshotted** on the order —
  later menu price changes never alter a placed order.

### Add items — `POST /:orderId/items`
`{ "items": [ …same shape… ] }`. Requires the order to still be `open`.

### Discounts — `PATCH …/discount` (order) and `PATCH …/items/:id/discount` (line)
Set: `{ discountType: 'percentage' | 'fixed', discountValue: number > 0, reason? }`
(percentage capped at 100). Clear: `{ discountType: null, discountValue: null }` —
**both must be null together**.

- Order-level discount applies to the subtotal **after** all per-line discounts.
- A `fixed` discount exceeding what it applies against is **rejected (400)** at
  apply time.
- Discounting an **already-voided** line is rejected (400).
- Requires `status === 'open'`.

### Cancel & void — `POST …/cancel`, `POST …/items/:id/void`
`{ wasPrepped: boolean, reason? }` — **`wasPrepped` is required**, never defaulted;
staff declare it explicitly, so the UI needs a deliberate yes/no control.

- Both require `status === 'open'`; both return the full order detail, **200**.
- **Voiding the last remaining active line is rejected (400)** — "cancel the order
  instead".
- No un-cancel, no un-void.
- Voided items **stay in the `items` array** (audit) but are excluded from every
  total. Cancelling the order does **not** zero the totals — `status` and
  `cancellation` are the authoritative "not charged" signal.
- **Neither creates a wastage log nor reverses inventory.** If stock was already
  deducted, it stays deducted.

### Item prep status — `PATCH …/items/:orderItemId/status`
`{ "status": "pending" | "in_progress" | "ready" | "served" }` — **`view_kds`**, not
`access_till`.

- **Transitions are unrestricted** — forward, backward, or skipping ahead. A mis-tap
  can be corrected.
- Blocked only by a **cancelled order** (400) or an **already-voided item** (400).
  A **paid** order still accepts status changes — payment does not stop the kitchen.
- Reaching **`ready`** (or `served`, the skip-ahead backstop) **fires the inventory
  deduction**, exactly once per line ever, guarded by an atomic claim. Re-entering
  the status never double-deducts. **This is not reversible** — a mis-tap onto
  `ready` moves real stock, correctable only via a manual `quantityOnHand` PATCH or
  a wastage entry. Consider a confirm step in the KDS UI.
- **Returns the KDS-narrowed view (§17), not the full order detail** — no money.

### Payments — `POST /:orderId/payments`
A **discriminated union on `method`**:
```jsonc
{ "method": "cash", "amountTendered": 20.00 }   // MAY exceed the balance
{ "method": "card", "amount": 15.50 }           // may NOT exceed the balance
```
- **Split/partial payment is simply calling this more than once.**
- Cash credits `min(amountTendered, balanceDue)` and derives `change`. Card over the
  balance is rejected (400) — there is nothing to give change from.
- **The first payment LOCKS the order**: status leaves `open`, and add-items,
  discounts, cancel and void all stop being accepted.
- A **declined card returns 402** with **zero payment rows written** and the order
  untouched. Show the cashier the decline and let them retry or switch to cash.
- Payments are immutable — no PATCH, no DELETE.
- **Known edge case:** an order whose total is £0 (e.g. a 100% discount) cannot be
  marked paid; a payment against it is rejected as "no outstanding balance", and it
  stays `open`. Handle this in the UI.

### Refunds — `POST /:orderId/payments/:paymentId/refund`
`{ amount: number > 0, reason? }` → **201**.
- A refund targets **one payment**, not the order — a card refund must reverse that
  specific charge.
- **Partial refunds = calling this more than once** against the same payment.
- No `method` field — it is always the parent payment's.
- Over-refunding beyond that payment's remaining refundable balance
  (`netAmount`) is rejected (400).
- A declined card refund returns **402** with zero rows written.
- **Once any refund is issued, the order accepts no further payment.** A partially
  paid order that is then refunded cannot be topped up — settle it as a new order.

### Offline sync — `POST /sync`
An idempotent queue of sales the till completed while offline.
```jsonc
{
  "clientOrderId": "device-local-id",       // 1–200 chars, any format
  "occurredAt": "2026-09-05T18:30:00.000Z", // ISO 8601 WITH offset, required
  "type": "dine_in" | "takeaway",
  "tableNumber": "…", "customerName": "…",
  "items": [{
    "menuItemId" | "shopMenuItemId": "uuid",
    "variantId": "uuid",
    "quantity": 1,
    "unitPrice": 8.50,                      // REQUIRED — what was actually charged
    "modifiers": [{ "modifierOptionId": "uuid", "priceDelta": 0.5 }]
  }],
  "payment": { "method": "cash", "amountTendered": 10 }   // REQUIRED
}
```
**Status codes are the whole contract here:**
| Code | Meaning | What the till does |
|---|---|---|
| **201** | First sync — order created | Remove from queue |
| **200** | Replay — same key, same payload; the original order is returned, nothing written | Remove from queue |
| **409** | Same key, **different** payload | Do **not** retry blindly — this is a real key collision |
| 400 | `platform`-mode card sale, or card over total | Cannot be synced as-is |
| 404 | Item/variant/modifier not in this shop's menu (incl. soft-deleted) | Cannot be synced |

- **Client-snapshotted prices are trusted as historical fact** — the server does not
  re-price, does not check `isEnabled`, and does not re-enforce modifier min/max.
- Payment scope: **cash always; card only when the company is in `own`
  `cardPaymentMode`.** A `platform` card sale is **400** — our provider must be
  reached live to authorise a card.
- A synced order is locked exactly like a paid online order.
- **It does NOT push to the KDS** — it's a historical record, not new kitchen work.
- Rejections write nothing and leave the `clientOrderId` free to retry.

### Order response — detail (`GET /:orderId`, and every write's 200/201)
```jsonc
{
  "id", "shopId", "type", "tableNumber", "customerName",
  "status": "open"|"cancelled"|"partially_paid"|"paid"|"partially_refunded"|"refunded",
  "createdByActorType", "createdByActorId",
  "orderNumber": 42,          // per-shop, per-day, human-readable. null on legacy orders
  "orderDate": "2026-09-06",  // a DATE string, not a timestamp

  "items": [{                 // includes voided lines (audit)
    "id", "menuItemId", "shopMenuItemId", "variantId",
    "itemName", "variantName",   // joined live, not snapshotted
    "quantity", "unitPrice",     // unitPrice IS snapshotted
    "modifiers": [{ "id", "modifierOptionId", "name", "priceDelta" }],
    "lineTotal",                 // PRE-discount
    "discount": null | { type, value, reason, appliedByActorType, appliedByActorId, appliedAt },
    "total",                     // post-discount
    "void": null | { voidedAt, voidedByActorType, voidedByActorId, reason, wasPrepped },
    "status": "pending"|"in_progress"|"ready"|"served",
    "statusUpdatedAt", "statusUpdatedByActorType", "statusUpdatedByActorId",
    "createdAt"
  }],

  "subtotal",            // pre-discount, ACTIVE items only, VAT-INCLUSIVE
  "itemDiscountTotal",
  "discount": null | {…},
  "discountAmount",
  "total",               // VAT-INCLUSIVE, floored at 0

  "vatRate",             // null on pre-VAT orders — an honest "never calculated"
  "vatExclusiveAmount",  // NOT called netAmount — that name is taken below
  "vatAmount",           // total − vatExclusiveAmount, reconciles EXACTLY

  "cancellation": null | { cancelledAt, cancelledByActorType, cancelledByActorId, reason, wasPrepped },

  "payments": [{
    "id", "method", "amount",
    "amountTendered",   // cash only, else null
    "change",           // derived, cash only, else null
    "providerReference",// null for cash AND for 'own' card mode
    "paidByActorType", "paidByActorId",
    "refunds": [{ "id", "amount", "reason", "providerReference", "refundedByActorType", "refundedByActorId", "createdAt" }],
    "amountRefunded",
    "netAmount",        // still refundable against THIS payment
    "createdAt"
  }],
  "amountPaid",         // GROSS — every payment ever, ignoring refunds
  "amountRefunded",
  "netAmountPaid",
  "balanceDue",         // total − netAmountPaid, floored at 0

  "clientOrderId", "occurredAt",   // null unless offline-synced
  "createdAt", "updatedAt"
}
```

**Money semantics you must not re-derive client-side:**
- `total` is **VAT-INCLUSIVE**. `vatAmount` is decomposed *out of* it, never added
  on top. Nothing the customer pays changes because of VAT.
- `vatRate` is **snapshotted at creation** — it never tracks later shop-settings
  changes. `null` means "this order predates VAT calculation", not "0%".
- `amountPaid` is gross; `netAmountPaid` nets off refunds; `balanceDue` uses the net.
- `netAmount` **inside a payment** means "still refundable"; `vatExclusiveAmount`
  **on the order** means "net of VAT". Two different things, deliberately two names.
- One shop-level VAT rate applies to the whole order. Mixed-rate baskets (hot food
  vs. zero-rated cold drink) are **not supported**.

### Order response — list (`GET /`)
`{ id, shopId, type, tableNumber, customerName, status, createdByActorType,
createdByActorId, itemCount, orderNumber, orderDate, clientOrderId, occurredAt,
createdAt, updatedAt }` — **no items, no money at all.** Fetch the detail for totals.

---

## 17. Kitchen Display System — WebSocket

```
GET wss://<host>/api/shops/:shopId/kds/socket
Authorization: Bearer <owner JWT | staff session token>
```

- **Same `Authorization` header as REST** — deliberately not a query-string token.
  Browsers cannot set headers on `new WebSocket(...)`, so a browser-based KDS needs
  a native-style client or a proxy; the Android/iOS apps set the header directly.
- Gated on **`view_kds`**. A refused handshake gets a **real HTTP response**
  (401/403/404) with the standard error envelope — not a socket that opens and
  immediately closes.
- **Every live socket is re-authorized on a 30-second heartbeat.** Deactivation,
  logout, session expiry, role change and a withdrawn override all disconnect the
  socket within ~30s. It fails **closed** on revoked auth and **open** on an
  infrastructure error. A connected KDS keeps its staff session alive.
- The registry is **in-memory and per-process** — correct for the single Render
  instance today; it would not fan out across multiple instances.

**Server → client messages** (all JSON, all carry `at`):
| `type` | Payload |
|---|---|
| `kds.connected` | `{ shopId, actor: { type, id }, at }` — handshake authenticated **and** authorized |
| `kds.unauthorized` | `{ statusCode, message, at }` — sent immediately before the server closes a revoked socket |
| `order.created` | `{ shopId, order: <KDS view>, at }` |
| `order.items_added` | same |
| `order.cancelled` | same |
| `order.item_voided` | same |
| `order.item_status_changed` | same — echoes the kitchen's own progress to every other screen in the shop |

Close codes: `4401` (unauthenticated), `4403` (forbidden), `4404` (not found).

**The KDS order view — an allow-list projection with every monetary field removed:**
```jsonc
{
  "id", "shopId",
  "orderNumber", "orderDate",     // what the kitchen actually calls the ticket
  "type", "tableNumber", "customerName",
  "status",                       // business/payment state — so the kitchen knows to stop
  "kitchenStatus",                // DERIVED: lowest item status across non-voided lines
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
Absent by design: `subtotal, itemDiscountTotal, discount, discountAmount, total,
vatRate, vatExclusiveAmount, vatAmount, payments, amountPaid, amountRefunded,
netAmountPaid, balanceDue`, per-item `unitPrice/lineTotal/discount/total`, and
per-modifier `priceDelta`.

`kitchenStatus` is the **lowest** status across non-voided items — a ticket only
reads `ready` once **every** line is. It is `null` only if nothing is active.
Note the two separate names: `status` = payment state, `kitchenStatus` = prep state.

**Reconnection:** there is no replay/backfill. On connect (or reconnect), fetch
`GET /api/shops/:shopId/orders` and hydrate, then apply socket events on top.

---

## 18. Stripe webhook (not for the frontend)

`POST /api/webhooks/stripe` — raw body, signature-verified, mounted before the JSON
parser. Called by Stripe only. Idempotent via a `stripe_webhook_events` table.

---

## 19. Endpoint count by area

| Area | REST endpoints |
|---|---|
| Health | 1 |
| Owner auth + profile | 13 |
| Staff auth | 2 |
| Company + billing | 7 |
| Master menu (categories, items, variants, modifiers, ingredients, recipes) | 40 |
| Cross-shop inventory overview | 1 |
| Shops + add-ons | 8 |
| Staff + permission overrides | 9 |
| Rota (shifts, swaps, attendance) | 15 |
| Shop menu (resolved + overrides + local items) | 17 |
| Inventory (items, supplier links, ingredient links) | 13 |
| Suppliers | 5 |
| Purchase orders + receiving | 5 |
| Wastage | 3 |
| Health & safety scans | 9 |
| Orders / till / payments / refunds / sync / status | 12 |
| Stripe webhook | 1 |
| **Total REST** | **~161** |
| WebSocket | 1 (`/api/shops/:shopId/kds/socket`) |

---

## 20. Not built yet — do not design around these

- **Module 11 — Loyalty/rewards**: program config, phone-based customer lookup,
  earn/redeem, chain-wide points.
- **Module 12 — Reporting**: sales, purchase/wastage, best/least-selling, custom
  date ranges, PDF export, chain consolidated view. **`view_reports` exists as a
  permission but nothing checks it yet.**
- **Module 13 — Real payment provider**: card processing today goes through a
  vendor-agnostic stub that touches no network in any environment. The
  `{ success, providerReference, failureReason }` contract will not change when a
  real SDK lands.

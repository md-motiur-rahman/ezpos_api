import { query } from "../../db/pool.js";
import { buildUpdateSet } from "../../utils/sql.js";

const COLUMNS = `id, owner_user_id, name, address_line1, address_line2, city, postcode,
                 country, phone, vat_number, company_number, business_type,
                 card_payment_mode,
                 stripe_customer_id, stripe_subscription_id, trial_ends_at,
                 has_payment_method,
                 subscription_status, grace_period_ends_at, created_at, updated_at`;

export async function findActiveCompanyByOwner(ownerUserId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM companies WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [ownerUserId],
  );
  return rows[0] ?? null;
}

/** Throws Postgres unique-violation (23505) if this owner already has an active company. */
export async function createCompany(ownerUserId, data) {
  const { rows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, address_line2, city, postcode, country, phone, vat_number, company_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${COLUMNS}`,
    [
      ownerUserId,
      data.name,
      data.addressLine1,
      data.addressLine2 ?? null,
      data.city,
      data.postcode,
      data.country,
      data.phone,
      data.vatNumber ?? null,
      data.companyNumber ?? null,
    ],
  );
  return rows[0];
}

/** Builds an UPDATE with only the fields present in `data` (partial update). */
export async function updateCompany(companyId, data) {
  const fieldMap = {
    name: "name",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    postcode: "postcode",
    country: "country",
    phone: "phone",
    vatNumber: "vat_number",
    companyNumber: "company_number",
  };

  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(companyId);
  const { rows } = await query(
    `UPDATE companies SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values,
  );
  return rows[0];
}

export async function softDeleteCompany(companyId) {
  await query(
    `UPDATE companies SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [companyId],
  );
}

export async function setBusinessType(companyId, businessType) {
  const { rows } = await query(
    `UPDATE companies SET business_type = $1, updated_at = now() WHERE id = $2 RETURNING ${COLUMNS}`,
    [businessType, companyId],
  );
  return rows[0];
}

export async function setCardPaymentMode(companyId, cardPaymentMode) {
  const { rows } = await query(
    `UPDATE companies SET card_payment_mode = $1, updated_at = now() WHERE id = $2 RETURNING ${COLUMNS}`,
    [cardPaymentMode, companyId],
  );
  return rows[0];
}

/**
 * Resolves the company that owns a shop. Needed by the till (Module 9): a
 * staff-authenticated payment knows its shopId but never the owner's user id,
 * so findActiveCompanyByOwner above can't be reused there.
 *
 * A subquery rather than a JOIN specifically so ${COLUMNS} is reused verbatim
 * with no table alias prefix - one definition of the column list, no second
 * copy to drift out of sync. A missing/deleted shop makes the subquery NULL,
 * which matches no row, so this correctly returns null rather than throwing.
 */
export async function findCompanyByShopId(shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM companies
     WHERE id = (SELECT company_id FROM shops WHERE id = $1 AND deleted_at IS NULL)
       AND deleted_at IS NULL`,
    [shopId],
  );
  return rows[0] ?? null;
}

export async function setStripeCustomerId(companyId, stripeCustomerId) {
  await query(
    `UPDATE companies SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`,
    [stripeCustomerId, companyId],
  );
}

/** Pass null to clear it (e.g. when the last shop closes and the subscription is cancelled). */
export async function setStripeSubscriptionId(companyId, stripeSubscriptionId) {
  await query(
    `UPDATE companies SET stripe_subscription_id = $1, updated_at = now() WHERE id = $2`,
    [stripeSubscriptionId, companyId],
  );
}

/**
 * Written when a company's first subscription is created (a non-null value
 * permanently marks the trial as used up, never cleared back to null), and
 * again - to an EARLIER value - if that same trial is cut short by adding a
 * second shop mid-trial (shop.service.js's own `createShop`, the "both
 * shops billed together, starting today" policy). That second write keeps
 * this column an honest answer to "when did/does the trial actually end"
 * rather than a stale date that stopped being true the moment the trial was
 * ended early - every screen that displays it (`/company`, `/shops/new`)
 * reads this column directly and would otherwise show a future date for a
 * trial that's already over.
 */
export async function setTrialEndsAt(companyId, trialEndsAt) {
  await query(
    `UPDATE companies SET trial_ends_at = $1, updated_at = now() WHERE id = $2`,
    [trialEndsAt, companyId],
  );
}

/**
 * Local mirror of "this Stripe customer has a default payment method", set by
 * the checkout.session.completed webhook so shop creation can check it without
 * a live Stripe call. Never cleared today: this app has no remove-card flow,
 * and a card can only be replaced by completing checkout again.
 */
export async function setHasPaymentMethod(companyId, hasPaymentMethod) {
  await query(
    `UPDATE companies SET has_payment_method = $1, updated_at = now() WHERE id = $2`,
    [hasPaymentMethod, companyId],
  );
}

/** Used by webhook handling to map a Stripe customer back to our company. */
export async function findByStripeCustomerId(stripeCustomerId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM companies WHERE stripe_customer_id = $1 AND deleted_at IS NULL`,
    [stripeCustomerId],
  );
  return rows[0] ?? null;
}

/** Written from Stripe webhooks - mirrors Stripe's own subscription status. */
export async function setSubscriptionStatus(companyId, subscriptionStatus) {
  await query(
    `UPDATE companies SET subscription_status = $1, updated_at = now() WHERE id = $2`,
    [subscriptionStatus, companyId],
  );
}

/** Pass null to clear it (payment recovered). */
export async function setGracePeriodEndsAt(companyId, gracePeriodEndsAt) {
  await query(`UPDATE companies SET grace_period_ends_at = $1, updated_at = now() WHERE id = $2`, [
    gracePeriodEndsAt,
    companyId,
  ]);
}

/**
 * Dashboard home (Module 15.1) — a daily revenue/expense series across every
 * active shop this company owns, for the last `days` calendar days
 * (inclusive of today), plus a per-shop revenue breakdown over that same
 * window. Read-only aggregate, deliberately NOT behind requireActiveBilling
 * (§3.6's own "reading stays available, only writes are blocked"
 * philosophy) — a locked-out owner can still see how the business has been
 * doing.
 *
 * **Revenue is defined as money that actually moved** (`SUM(order_payments.amount)
 * MINUS SUM(order_refunds.amount)`, keyed by each row's own `created_at`),
 * not anything derived from `orders.status` or summed from order totals —
 * the same "payments/refunds are the source of truth for money taken"
 * precedent `order.service.js`'s own `recordPayment`/`refundPayment` already
 * establish. **Expense is purchase-order cost** (`quantity * unit_cost`,
 * the exact `COALESCE(SUM(...), 0)` expression `purchaseOrder.repository.js`
 * already uses for `PurchaseOrderSummary.totalCost` — one definition,
 * reused here rather than re-derived), keyed by `ordered_at`. There is no
 * other "expense" concept modeled anywhere in this system today (no payroll,
 * no rent, no manual entries) — this is a deliberately honest label for what
 * is actually trackable, not a full P&L.
 *
 * **Revenue and refunds are aggregated in separate CTEs before being joined
 * to the day/shop grain, never combined via a single multi-table LEFT JOIN**
 * — an order can have several payments and several refunds, and refunds
 * join to `order_payments` (not `orders`) on `payment_id`; joining both
 * one-to-many relationships in the same row set fans out and silently
 * double-counts `payments.amount` once per matching refund row. Pre-aggregating
 * each side down to one row per day (or per shop) before the final join
 * avoids that entirely.
 *
 * **`shopBreakdown`'s CTEs carry an explicit upper bound (`<= end_day`) on
 * BOTH `payments_by_shop` and `refunds_by_shop`, matching the `series`
 * query's own window exactly** — caught by CodeRabbit, since the original
 * only had `>= start_day`. `series` is naturally protected from anything
 * past today: it's driven FROM `days` (`generate_series` truncated to
 * `current_date`), and a LEFT JOIN keyed on `day` simply has no row for a
 * date past that to match. `shopBreakdown` has no such structural
 * protection - it's driven FROM `shops` and joined on `shop_id`, not on any
 * day boundary at all, so without this explicit upper bound any
 * payment/refund dated after the window (a clock-skewed insert, backfilled
 * test data, a future-dated row of any origin) would silently inflate a
 * shop's revenue while never showing up in the day-by-day `series` its own
 * total is supposed to reconcile against - two views of the same money that
 * could quietly disagree.
 */
export async function getDashboardSummary(companyId, days) {
  const { rows: series } = await query(
    `WITH shop_ids AS (
       SELECT id FROM shops WHERE company_id = $1 AND deleted_at IS NULL
     ),
     bounds AS (
       SELECT (current_date - ($2::int - 1)) AS start_day, current_date AS end_day
     ),
     days AS (
       SELECT generate_series(start_day, end_day, interval '1 day')::date AS day
       FROM bounds
     ),
     payments AS (
       SELECT op.created_at::date AS day, SUM(op.amount) AS amount
       FROM order_payments op
       JOIN orders o ON o.id = op.order_id
       WHERE o.shop_id IN (SELECT id FROM shop_ids)
         AND op.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     refunds AS (
       SELECT orf.created_at::date AS day, SUM(orf.amount) AS amount
       FROM order_refunds orf
       JOIN order_payments op ON op.id = orf.payment_id
       JOIN orders o ON o.id = op.order_id
       WHERE o.shop_id IN (SELECT id FROM shop_ids)
         AND orf.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     expenses AS (
       SELECT po.ordered_at::date AS day, COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS amount
       FROM purchase_orders po
       JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.shop_id IN (SELECT id FROM shop_ids)
         AND po.deleted_at IS NULL
         AND po.ordered_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     ),
     order_counts AS (
       SELECT o.created_at::date AS day, count(*) AS count
       FROM orders o
       WHERE o.shop_id IN (SELECT id FROM shop_ids)
         AND o.created_at::date >= (SELECT start_day FROM bounds)
       GROUP BY 1
     )
     SELECT
       to_char(days.day, 'YYYY-MM-DD') AS day,
       COALESCE(payments.amount, 0) - COALESCE(refunds.amount, 0) AS revenue,
       COALESCE(expenses.amount, 0) AS expense,
       COALESCE(order_counts.count, 0)::int AS order_count
     FROM days
     LEFT JOIN payments ON payments.day = days.day
     LEFT JOIN refunds ON refunds.day = days.day
     LEFT JOIN expenses ON expenses.day = days.day
     LEFT JOIN order_counts ON order_counts.day = days.day
     ORDER BY days.day`,
    [companyId, days]
  );

  const { rows: shopBreakdown } = await query(
    `WITH bounds AS (
       SELECT (current_date - ($2::int - 1)) AS start_day, current_date AS end_day
     ),
     payments_by_shop AS (
       SELECT o.shop_id, SUM(op.amount) AS gross
       FROM orders o
       JOIN order_payments op ON op.order_id = o.id
       WHERE op.created_at::date >= (SELECT start_day FROM bounds)
         AND op.created_at::date <= (SELECT end_day FROM bounds)
       GROUP BY o.shop_id
     ),
     refunds_by_shop AS (
       SELECT o.shop_id, SUM(orf.amount) AS refunded
       FROM orders o
       JOIN order_payments op ON op.order_id = o.id
       JOIN order_refunds orf ON orf.payment_id = op.id
       WHERE orf.created_at::date >= (SELECT start_day FROM bounds)
         AND orf.created_at::date <= (SELECT end_day FROM bounds)
       GROUP BY o.shop_id
     )
     SELECT s.id AS shop_id, s.name AS shop_name,
            COALESCE(p.gross, 0) - COALESCE(r.refunded, 0) AS revenue
     FROM shops s
     LEFT JOIN payments_by_shop p ON p.shop_id = s.id
     LEFT JOIN refunds_by_shop r ON r.shop_id = s.id
     WHERE s.company_id = $1 AND s.deleted_at IS NULL
     ORDER BY s.created_at`,
    [companyId, days]
  );

  return { series, shopBreakdown };
}

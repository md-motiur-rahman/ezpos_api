import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, owner_user_id, name, address_line1, address_line2, city, postcode,
                 country, phone, vat_number, company_number, business_type,
                 stripe_customer_id, stripe_subscription_id, trial_ends_at,
                 subscription_status, created_at, updated_at`;

export async function findActiveCompanyByOwner(ownerUserId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM companies WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [ownerUserId]
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
    ]
  );
  return rows[0];
}

/** Builds an UPDATE with only the fields present in `data` (partial update). */
export async function updateCompany(companyId, data) {
  const fieldMap = {
    name: 'name',
    addressLine1: 'address_line1',
    addressLine2: 'address_line2',
    city: 'city',
    postcode: 'postcode',
    country: 'country',
    phone: 'phone',
    vatNumber: 'vat_number',
    companyNumber: 'company_number',
  };

  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(companyId);
  const { rows } = await query(
    `UPDATE companies SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteCompany(companyId) {
  await query(`UPDATE companies SET deleted_at = now(), updated_at = now() WHERE id = $1`, [
    companyId,
  ]);
}

export async function setBusinessType(companyId, businessType) {
  const { rows } = await query(
    `UPDATE companies SET business_type = $1, updated_at = now() WHERE id = $2 RETURNING ${COLUMNS}`,
    [businessType, companyId]
  );
  return rows[0];
}

export async function setStripeCustomerId(companyId, stripeCustomerId) {
  await query(`UPDATE companies SET stripe_customer_id = $1, updated_at = now() WHERE id = $2`, [
    stripeCustomerId,
    companyId,
  ]);
}

/** Pass null to clear it (e.g. when the last shop closes and the subscription is cancelled). */
export async function setStripeSubscriptionId(companyId, stripeSubscriptionId) {
  await query(`UPDATE companies SET stripe_subscription_id = $1, updated_at = now() WHERE id = $2`, [
    stripeSubscriptionId,
    companyId,
  ]);
}

/**
 * Written exactly once per company, when its first subscription is created.
 * Never cleared - a non-null value permanently marks the trial as used up.
 */
export async function setTrialEndsAt(companyId, trialEndsAt) {
  await query(`UPDATE companies SET trial_ends_at = $1, updated_at = now() WHERE id = $2`, [
    trialEndsAt,
    companyId,
  ]);
}

/** Used by webhook handling to map a Stripe customer back to our company. */
export async function findByStripeCustomerId(stripeCustomerId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM companies WHERE stripe_customer_id = $1 AND deleted_at IS NULL`,
    [stripeCustomerId]
  );
  return rows[0] ?? null;
}

/** Written from Stripe webhooks - mirrors Stripe's own subscription status. */
export async function setSubscriptionStatus(companyId, subscriptionStatus) {
  await query(`UPDATE companies SET subscription_status = $1, updated_at = now() WHERE id = $2`, [
    subscriptionStatus,
    companyId,
  ]);
}
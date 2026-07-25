import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, company_id, name, address_line1, address_line2, city, postcode,
                 country, phone, kds_enabled, rota_enabled, vat_registered,
                 default_vat_rate, stripe_subscription_item_id, created_at, updated_at`;

export async function countActiveShopsForCompany(companyId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM shops WHERE company_id = $1 AND deleted_at IS NULL`,
    [companyId]
  );
  return rows[0].count;
}

export async function createShop(companyId, data) {
  const { rows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, address_line2, city, postcode, country, phone,
        kds_enabled, rota_enabled, vat_registered, default_vat_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      companyId,
      data.name,
      data.addressLine1,
      data.addressLine2 ?? null,
      data.city,
      data.postcode,
      data.country,
      data.phone,
      data.kdsEnabled ?? false,
      data.rotaEnabled ?? false,
      data.vatRegistered,
      data.defaultVatRate ?? null,
    ]
  );
  return rows[0];
}

export async function listActiveShopsForCompany(companyId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shops WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [companyId]
  );
  return rows;
}

/**
 * Ownership is baked directly into the WHERE clause: a shop that doesn't
 * exist and a shop that belongs to someone else's company both simply come
 * back as null - the service/controller layer doesn't need to tell them apart.
 */
export async function findActiveShopByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shops WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateShop(id, data) {
  const fieldMap = {
    name: 'name',
    addressLine1: 'address_line1',
    addressLine2: 'address_line2',
    city: 'city',
    postcode: 'postcode',
    country: 'country',
    phone: 'phone',
    kdsEnabled: 'kds_enabled',
    rotaEnabled: 'rota_enabled',
    vatRegistered: 'vat_registered',
    defaultVatRate: 'default_vat_rate',
  };

  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE shops SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteShop(id) {
  await query(`UPDATE shops SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

export async function setStripeSubscriptionItemId(id, stripeSubscriptionItemId) {
  await query(
    `UPDATE shops SET stripe_subscription_item_id = $1, updated_at = now() WHERE id = $2`,
    [stripeSubscriptionItemId, id]
  );
}
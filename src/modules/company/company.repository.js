import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, owner_user_id, name, address_line1, address_line2, city, postcode,
                 country, phone, vat_number, company_number, business_type, created_at, updated_at`;

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
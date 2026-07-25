import { query } from '../../db/pool.js';

const COLUMNS = `id, company_id, name, address_line1, address_line2, city, postcode,
                 country, phone, created_at, updated_at`;

export async function countActiveShopsForCompany(companyId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM shops WHERE company_id = $1 AND deleted_at IS NULL`,
    [companyId]
  );
  return rows[0].count;
}

export async function createShop(companyId, data) {
  const { rows } = await query(
    `INSERT INTO shops (company_id, name, address_line1, address_line2, city, postcode, country, phone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
  };

  const setClauses = [];
  const values = [];
  for (const [key, column] of Object.entries(fieldMap)) {
    if (data[key] !== undefined) {
      values.push(data[key]);
      setClauses.push(`${column} = $${values.length}`);
    }
  }
  setClauses.push('updated_at = now()');

  values.push(id);
  const { rows } = await query(
    `UPDATE shops SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteShop(id) {
  await query(`UPDATE shops SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
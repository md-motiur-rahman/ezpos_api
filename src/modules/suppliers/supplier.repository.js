import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, shop_id, name, contact_name, phone, email, notes, created_at, updated_at`;

export async function createSupplier(shopId, { name, contactName, phone, email, notes }) {
  const { rows } = await query(
    `INSERT INTO suppliers (shop_id, name, contact_name, phone, email, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [shopId, name, contactName ?? null, phone ?? null, email ?? null, notes ?? null]
  );
  return rows[0];
}

export async function listActiveSuppliersForShop(shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM suppliers
     WHERE shop_id = $1 AND deleted_at IS NULL
     ORDER BY name`,
    [shopId]
  );
  return rows;
}

export async function findActiveSupplierByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM suppliers
     WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function updateSupplier(id, data) {
  const fieldMap = {
    name: 'name',
    contactName: 'contact_name',
    phone: 'phone',
    email: 'email',
    notes: 'notes',
  };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE suppliers SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteSupplier(id) {
  await query(`UPDATE suppliers SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
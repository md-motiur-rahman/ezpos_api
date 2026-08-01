import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, shop_id, full_name, role, staff_id_code, created_at, updated_at`;

/**
 * Throws Postgres unique-violation (23505) if staff_id_code collides with an
 * active one on this shop - the service layer retries with a new code on
 * that error, rather than us pre-checking (check-then-insert race).
 */
export async function createStaff(shopId, { fullName, role, staffIdCode, pinHash }) {
  const { rows } = await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [shopId, fullName, role, staffIdCode, pinHash]
  );
  return rows[0];
}

export async function listActiveStaffForShop(shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM staff WHERE shop_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [shopId]
  );
  return rows;
}

/**
 * Unscoped by shop - used when the caller doesn't yet know which shop the
 * staff member belongs to (Module 4.4's permission endpoints, which resolve
 * the target first, then check the actor's authority over that target's shop).
 */
export async function findActiveStaffById(id) {
  const { rows } = await query(`SELECT ${COLUMNS} FROM staff WHERE id = $1 AND deleted_at IS NULL`, [
    id,
  ]);
  return rows[0] ?? null;
}

/**
 * Ownership scoped directly in the WHERE clause, same pattern as shops: a
 * staff member that doesn't exist and one belonging to a different shop both
 * simply come back as null.
 */
export async function findActiveStaffByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM staff WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function updateStaff(id, data) {
  const fieldMap = { fullName: 'full_name', role: 'role' };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE staff SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteStaff(id) {
  await query(`UPDATE staff SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
import { query } from '../../db/pool.js';

/** Throws Postgres unique-violation (23505) if already active - the service layer catches it. */
export async function createOverride(staffId, permission, grantedBy) {
  const { rows } = await query(
    `INSERT INTO staff_permission_overrides (staff_id, permission, granted_by)
     VALUES ($1, $2, $3)
     RETURNING id, staff_id, permission, granted_by, created_at`,
    [staffId, permission, grantedBy]
  );
  return rows[0];
}

export async function listActivePermissionsForStaff(staffId) {
  const { rows } = await query(
    `SELECT permission FROM staff_permission_overrides WHERE staff_id = $1 AND revoked_at IS NULL`,
    [staffId]
  );
  return rows.map((row) => row.permission);
}

export async function findActiveOverride(staffId, permission) {
  const { rows } = await query(
    `SELECT id FROM staff_permission_overrides
     WHERE staff_id = $1 AND permission = $2 AND revoked_at IS NULL`,
    [staffId, permission]
  );
  return rows[0] ?? null;
}

export async function revokeOverride(id) {
  await query(`UPDATE staff_permission_overrides SET revoked_at = now() WHERE id = $1`, [id]);
}
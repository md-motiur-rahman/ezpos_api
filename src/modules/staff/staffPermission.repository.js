import { query } from '../../db/pool.js';

/** Throws Postgres unique-violation (23505) if already active - the service layer catches it. */
export async function createOverride(staffId, permission, grantedByType, grantedById) {
  const { rows } = await query(
    `INSERT INTO staff_permission_overrides (staff_id, permission, granted_by_type, granted_by_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, staff_id, permission, granted_by_type, granted_by_id, created_at`,
    [staffId, permission, grantedByType, grantedById]
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

export async function revokeOverride(id, revokedByType, revokedById) {
  await query(
    `UPDATE staff_permission_overrides
     SET revoked_at = now(), revoked_by_type = $1, revoked_by_id = $2
     WHERE id = $3`,
    [revokedByType, revokedById, id]
  );
}

/**
 * Includes BOTH active and revoked entries, and entries for since-deactivated
 * staff (no staff.deleted_at filter) - an audit log that hides history isn't
 * an audit log, and "X granted Y to Z" stays a true historical fact
 * regardless of Z's current status. Joins staff only to filter by shop, since
 * this table doesn't carry shop_id directly.
 */
export async function listAuditLogForShop(shopId, limit) {
  const { rows } = await query(
    `SELECT spo.id, spo.staff_id, spo.permission, spo.granted_by_type, spo.granted_by_id,
            spo.created_at, spo.revoked_by_type, spo.revoked_by_id, spo.revoked_at
     FROM staff_permission_overrides spo
     JOIN staff s ON s.id = spo.staff_id
     WHERE s.shop_id = $1
     ORDER BY spo.created_at DESC
     LIMIT $2`,
    [shopId, limit]
  );
  return rows;
}
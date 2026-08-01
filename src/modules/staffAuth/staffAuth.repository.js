import { query } from '../../db/pool.js';

/**
 * Everything needed to attempt a login in one query: the PIN hash to check
 * against, plus the company's billing state - efficient for a
 * latency-sensitive till boot-up path, avoids a second round trip just to
 * check whether the company is billing-locked.
 */
export async function findLoginContext(shopId, staffIdCode) {
  const { rows } = await query(
    `SELECT s.id, s.full_name, s.role, s.pin_hash, s.shop_id,
            c.subscription_status, c.grace_period_ends_at
     FROM staff s
     JOIN shops sh ON sh.id = s.shop_id AND sh.deleted_at IS NULL
     JOIN companies c ON c.id = sh.company_id AND c.deleted_at IS NULL
     WHERE s.shop_id = $1 AND s.staff_id_code = $2 AND s.deleted_at IS NULL`,
    [shopId, staffIdCode]
  );
  return rows[0] ?? null;
}

export async function createSession(staffId, tokenHash) {
  const { rows } = await query(
    `INSERT INTO staff_sessions (staff_id, token_hash) VALUES ($1, $2) RETURNING id`,
    [staffId, tokenHash]
  );
  return rows[0];
}

/**
 * Joining staff with `deleted_at IS NULL` means a deactivated staff member's
 * session simply stops matching here - no explicit revocation step needed
 * when a staff member is deactivated (resolves the Module 4.2 dependency
 * note as a consequence of this query, not extra code).
 */
export async function findValidSessionContext(tokenHash) {
  const { rows } = await query(
    `SELECT ss.id, ss.staff_id, ss.last_active_at, s.full_name, s.role, s.shop_id
     FROM staff_sessions ss
     JOIN staff s ON s.id = ss.staff_id AND s.deleted_at IS NULL
     WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

export async function updateLastActive(sessionId) {
  await query(`UPDATE staff_sessions SET last_active_at = now() WHERE id = $1`, [sessionId]);
}

export async function revokeSession(tokenHash) {
  await query(
    `UPDATE staff_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash]
  );
}
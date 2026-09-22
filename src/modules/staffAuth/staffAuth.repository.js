import { query } from '../../db/pool.js';

/**
 * Everything needed to attempt a login against EVERY shop whose
 * `staff_id_code` matches - one query, one row per candidate, each carrying
 * the PIN hash to check and the owning company's billing state. Plural,
 * not singular, and no `shopId` parameter: `staff_id_code` is only unique
 * PER SHOP (a partial index on `(shop_id, staff_id_code)`, confirmed
 * reading the `staff` table's own migration directly, never a global one),
 * so the same 8-digit code can legitimately belong to a different staff
 * member at a different shop. `staffAuth.service.js`'s own `login` is what
 * turns "0, 1, or several candidates" into a real login decision, by
 * checking the PIN against each one - see its own doc for why that's safe.
 */
export async function findLoginContextsByStaffIdCode(staffIdCode) {
  const { rows } = await query(
    `SELECT s.id, s.full_name, s.role, s.pin_hash, s.shop_id,
            c.subscription_status, c.grace_period_ends_at
     FROM staff s
     JOIN shops sh ON sh.id = s.shop_id AND sh.deleted_at IS NULL
     JOIN companies c ON c.id = sh.company_id AND c.deleted_at IS NULL
     WHERE s.staff_id_code = $1 AND s.deleted_at IS NULL`,
    [staffIdCode]
  );
  return rows;
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

/** Self-service PIN change's own lookup - just the hash to compare against,
 * scoped by id (from an already-verified session via `requireStaffAuth`),
 * unlike `findLoginContextsByStaffIdCode` which has to search broadly
 * because login itself has no id yet. */
export async function findPinHashById(staffId) {
  const { rows } = await query(`SELECT pin_hash FROM staff WHERE id = $1 AND deleted_at IS NULL`, [
    staffId,
  ]);
  return rows[0] ?? null;
}

/**
 * `client` defaults to the shared pool but `staffAuth.service.js`'s
 * `changePin` passes its transaction's own client instead, alongside the
 * same call's `revokeAllSessionsForStaff` - the two must commit or roll
 * back together (CodeRabbit finding: without this, a session-revocation
 * failure could leave the PIN changed while every old session, including
 * the one an attacker who obtained the old PIN might be holding, stays
 * valid).
 */
export async function updatePinHash(staffId, pinHash, client = { query }) {
  await client.query(`UPDATE staff SET pin_hash = $1, updated_at = now() WHERE id = $2`, [
    pinHash,
    staffId,
  ]);
}

/** Every active session for one staff member, not just the one making the
 * request - same "a credential change outlives no session, including the
 * caller's own" policy `auth.repository.js`'s `revokeAllRefreshTokensForUser`
 * already established for an owner's password change. `client` defaults to
 * the shared pool; `changePin` passes its transaction's own client, same
 * reasoning as `updatePinHash`'s own doc above. */
export async function revokeAllSessionsForStaff(staffId, client = { query }) {
  await client.query(
    `UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`,
    [staffId]
  );
}
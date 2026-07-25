import { query } from '../../db/pool.js';

export async function findUserByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, password_hash, full_name, email_verified_at
     FROM users
     WHERE email = $1 AND deleted_at IS NULL`,
    [email]
  );
  return rows[0] ?? null;
}

export async function findUserById(id) {
  const { rows } = await query(
    `SELECT id, email, full_name, email_verified_at
     FROM users
     WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Throws a Postgres unique-violation error (code 23505) if the email is
 * already taken - the service layer catches that rather than us doing a
 * separate SELECT-then-INSERT, which would leave a race condition between
 * the check and the insert.
 */
export async function createUser({ email, passwordHash, fullName }) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING id, email, full_name, email_verified_at`,
    [email, passwordHash, fullName]
  );
  return rows[0];
}

export async function markEmailVerified(userId) {
  await query(`UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1`, [
    userId,
  ]);
}

export async function createVerificationToken({ userId, tokenHash, purpose, expiresAt }) {
  const { rows } = await query(
    `INSERT INTO verification_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [userId, tokenHash, purpose, expiresAt]
  );
  return rows[0];
}

/**
 * Finds a token that is still valid: matching hash+purpose, not expired,
 * not already used.
 */
export async function findValidToken({ tokenHash, purpose }) {
  const { rows } = await query(
    `SELECT id, user_id, expires_at, used_at
     FROM verification_tokens
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash, purpose]
  );
  return rows[0] ?? null;
}

export async function markTokenUsed(tokenId) {
  await query(`UPDATE verification_tokens SET used_at = now() WHERE id = $1`, [tokenId]);
}

/**
 * Deletes any still-unused tokens of this purpose for this user before a
 * new one is issued (e.g. on resend), so only one valid token exists at a
 * time. These are short-lived security artifacts, not business records, so
 * a hard delete here (rather than soft-delete) is appropriate.
 */
export async function deleteUnusedTokens({ userId, purpose }) {
  await query(`DELETE FROM verification_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [
    userId,
    purpose,
  ]);
}

export async function createRefreshToken({ userId, tokenHash, expiresAt }) {
  const { rows } = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id`,
    [userId, tokenHash, expiresAt]
  );
  return rows[0];
}

export async function findValidRefreshToken(tokenHash) {
  const { rows } = await query(
    `SELECT id, user_id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

export async function revokeRefreshToken(id) {
  await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [id]);
}
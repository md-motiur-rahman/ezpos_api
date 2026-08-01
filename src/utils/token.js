import crypto from 'node:crypto';

/**
 * Generates a high-entropy random token. The raw value is what goes out to
 * the caller (email link, session token, ...) and is never stored; the hash
 * is what gets persisted, so a leaked database never exposes usable tokens.
 *
 * Shared by auth.service.js (verification/reset/refresh tokens) and
 * staffAuth.service.js (till session tokens) - same logic, same guarantees.
 */
export function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}
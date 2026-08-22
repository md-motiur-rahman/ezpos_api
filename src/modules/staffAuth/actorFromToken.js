import crypto from 'node:crypto';
import { verifyAccessToken } from '../../utils/jwt.js';
import * as staffAuthRepository from './staffAuth.repository.js';
import { isSessionExpired } from './staffSession.access.js';

/**
 * The ONE definition of "turn a bearer token into an actor" (10.1).
 *
 * Extracted verbatim out of requireStaffOrOwnerAuth's body when the KDS
 * WebSocket handshake (10.1) became the second caller. A WebSocket upgrade
 * never passes through Express's middleware pipeline at all - Node routes
 * upgrade requests exclusively to the http.Server's 'upgrade' listeners,
 * never to the 'request' listener Express is mounted on - so the socket
 * handshake genuinely cannot reuse the middleware itself, only the logic
 * inside it.
 *
 * Sharing it rather than writing a second copy is deliberate and was
 * confirmed directly: this is security-critical logic, and two independent
 * copies of "how do we authenticate somebody" is exactly the kind of pair
 * that silently drifts when only one is updated. Lives in staffAuth/ because
 * the DB resource it actually operates on is that module's staff_sessions
 * table (CLAUDE.md section 2: helpers live with the resource they operate
 * on), even though it also handles the owner JWT, which touches no table.
 *
 * Returns the actor, or NULL when the token is absent/invalid/expired.
 * Deliberately returns null rather than throwing for an auth FAILURE, so
 * each caller can shape its own rejection - the middleware raises a 401
 * AppError, the socket handshake writes a raw HTTP 401 to the socket, and
 * neither has to catch the other's error type. A genuine INFRASTRUCTURE
 * failure (the database being unreachable) still throws, and must keep
 * throwing: that is a 500, not an authentication failure, and silently
 * treating it as "not authenticated" would turn an outage into a
 * misleading 401.
 *
 * Tries the cheap, local, no-DB JWT check first, exactly as before; only
 * falls through to a staff-session DB lookup if that fails.
 */
export async function resolveActorFromToken(token) {
  if (!token) {
    return null;
  }

  try {
    const payload = verifyAccessToken(token);
    return { type: 'owner', id: payload.sub, email: payload.email };
  } catch {
    // Not a valid owner JWT - fall through to a staff session check.
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await staffAuthRepository.findValidSessionContext(tokenHash);

  if (!session || isSessionExpired(session)) {
    return null;
  }

  // The sliding 60-minute window (CLAUDE.md section 2) - touching the
  // session keeps it alive. Preserved here exactly as the middleware did
  // it, so an authenticated request/handshake still refreshes the session.
  await staffAuthRepository.updateLastActive(session.id);

  return {
    type: 'staff',
    id: session.staff_id,
    role: session.role,
    shopId: session.shop_id,
  };
}

/**
 * Pulls the raw token out of an Authorization header value, or null if the
 * header is missing or isn't a Bearer one. Split out alongside the resolver
 * because the socket handshake reads the header off a raw Node
 * IncomingMessage rather than an Express request - the parsing rule is
 * identical, only the object it comes from differs.
 */
export function bearerTokenFrom(authorizationHeader) {
  const header = authorizationHeader ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

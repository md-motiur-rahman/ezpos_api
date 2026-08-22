import { AppError } from '../utils/AppError.js';
import { resolveActorFromToken, bearerTokenFrom } from '../modules/staffAuth/actorFromToken.js';

/**
 * Accepts EITHER an owner JWT (Module 1.2) OR a staff session token
 * (Module 4.3) on the same Bearer header, attaching req.actor = { type:
 * 'owner', id, email } or { type: 'staff', id, role, shopId } accordingly.
 *
 * Built specifically for Module 4.4's permission-management endpoints,
 * which are the first case in this project where BOTH an owner and a staff
 * member (a Manager granting to a Shift Manager) are legitimate callers of
 * the same action. Deliberately NOT used to replace requireAuth on any
 * existing owner-only route - this only gates the new
 * /api/staff-permissions/* routes, keeping the blast radius contained to
 * genuinely new endpoints rather than widening what staff sessions can do
 * elsewhere.
 *
 * The actual token-to-actor logic moved to staffAuth/actorFromToken.js in
 * 10.1, when the KDS WebSocket handshake became a second caller that cannot
 * run Express middleware at all (a WebSocket upgrade never reaches Express).
 * This function is now a thin wrapper over that shared resolver and is
 * behaviourally IDENTICAL to before: the same "try the cheap local JWT
 * first, fall through to a staff-session DB lookup" order, the same 401 on
 * any authentication failure, and the same next(err) - i.e. a 500 - if the
 * database itself fails, which is why the resolver returns null for an auth
 * failure but still THROWS for an infrastructure one.
 */
export async function requireStaffOrOwnerAuth(req, res, next) {
  const token = bearerTokenFrom(req.headers.authorization);

  if (!token) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const actor = await resolveActorFromToken(token);

    if (!actor) {
      return next(new AppError('Authentication required', 401));
    }

    req.actor = actor;
    next();
  } catch (err) {
    next(err);
  }
}

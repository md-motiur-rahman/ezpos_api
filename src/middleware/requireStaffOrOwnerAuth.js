import crypto from 'node:crypto';
import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/AppError.js';
import * as staffAuthRepository from '../modules/staffAuth/staffAuth.repository.js';
import { isSessionExpired } from '../modules/staffAuth/staffSession.access.js';

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
 * Tries the (cheap, local, no DB call) JWT check first; only falls through
 * to a staff-session DB lookup if that fails.
 */
export async function requireStaffOrOwnerAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const payload = verifyAccessToken(token);
    req.actor = { type: 'owner', id: payload.sub, email: payload.email };
    return next();
  } catch {
    // Not a valid owner JWT - fall through to a staff session check.
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await staffAuthRepository.findValidSessionContext(tokenHash);

    if (!session || isSessionExpired(session)) {
      return next(new AppError('Authentication required', 401));
    }

    await staffAuthRepository.updateLastActive(session.id);
    req.actor = {
      type: 'staff',
      id: session.staff_id,
      role: session.role,
      shopId: session.shop_id,
    };
    next();
  } catch (err) {
    next(err);
  }
}
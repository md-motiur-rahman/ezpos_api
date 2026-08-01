import crypto from 'node:crypto';
import { AppError } from '../utils/AppError.js';
import * as staffAuthRepository from '../modules/staffAuth/staffAuth.repository.js';
import { isSessionExpired } from '../modules/staffAuth/staffSession.access.js';

/**
 * Verifies a staff session token and attaches req.staff = { id, fullName,
 * role, shopId }. Uses the same Authorization: Bearer <token> convention as
 * requireAuth (owner JWTs) - the two are distinguished by which middleware a
 * route uses, not by the header shape.
 *
 * Not applied to any route yet - no protected till/staff-facing route exists
 * until Module 9. Built and unit-tested now (mocked req/res/next, same
 * precedent as requireAuth in Module 1.2) so it's ready to apply then.
 */
export async function requireStaffAuth(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return next(new AppError('Staff authentication required', 401));
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await staffAuthRepository.findValidSessionContext(tokenHash);

    if (!session || isSessionExpired(session)) {
      return next(new AppError('Staff session invalid or expired', 401));
    }

    // Valid + active request slides the 60-minute window forward.
    await staffAuthRepository.updateLastActive(session.id);

    req.staff = {
      id: session.staff_id,
      fullName: session.full_name,
      role: session.role,
      shopId: session.shop_id,
    };
    next();
  } catch (err) {
    next(err);
  }
}
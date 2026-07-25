import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/AppError.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new AppError('Invalid or expired token', 401));
  }
}
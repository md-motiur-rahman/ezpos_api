import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireStaffAuth } from '../../middleware/requireStaffAuth.js';
import { validateBody } from '../../middleware/validate.js';
import * as staffAuthController from './staffAuth.controller.js';
import { staffLoginSchema, staffLogoutSchema, changePinSchema } from './staffAuth.validation.js';

const router = Router();

/**
 * Stricter than the global limiter (300/15min): an 8-digit PIN is weaker
 * than a password, and a till sits in a more exposed physical environment
 * than a website login.
 *
 * Keyed by (IP, staffIdCode), not IP alone - the default express-rate-limit
 * behavior. REVISED from (IP, shopId): the request no longer carries a
 * shopId at all (`staffLoginSchema`'s own doc explains why), and
 * `staffIdCode` is actually the better scope regardless of that change - a
 * PIN brute-force attack is "many attempts against ONE specific staff
 * code", which this keys on directly, rather than "many attempts against
 * one shop" (a shop can have several staff, so the old key was already
 * coarser than the attack it was meant to scope). Still not IP alone, for
 * the identical reason the original comment gave: unrelated attempts
 * sharing a NAT/corporate egress IP must not rate-limit each other (this
 * surfaced running the full test suite in one process - many independent
 * test files' staff logins, each their own freshly-created staff member,
 * shared one IP-only counter and exhausted it well before unrelated ones
 * should have been affected at all).
 */
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many login attempts, please try again later.' } },
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.staffIdCode ?? 'unknown'}`,
});

router.post('/login', staffLoginLimiter, validateBody(staffLoginSchema), staffAuthController.login);
router.post('/logout', validateBody(staffLogoutSchema), staffAuthController.logout);

/**
 * Keyed by the authenticated staff id, not IP - unlike login, this route
 * already knows exactly who's calling (`requireStaffAuth` runs first), so
 * that's the more precise scope for "many attempts against one staff
 * member's PIN" than an IP shared with unrelated tills/sessions would be.
 */
const changePinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts, please try again later.' } },
  keyGenerator: (req) => req.staff?.id ?? ipKeyGenerator(req.ip),
});

router.post(
  '/change-pin',
  requireStaffAuth,
  changePinLimiter,
  validateBody(changePinSchema),
  staffAuthController.changePin
);

export default router;
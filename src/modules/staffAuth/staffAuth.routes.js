import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { validateBody } from '../../middleware/validate.js';
import * as staffAuthController from './staffAuth.controller.js';
import { staffLoginSchema, staffLogoutSchema } from './staffAuth.validation.js';

const router = Router();

/**
 * Stricter than the global limiter (300/15min): an 8-digit PIN is weaker
 * than a password, and a till sits in a more exposed physical environment
 * than a website login.
 *
 * Keyed by (IP, shopId), not IP alone - the default express-rate-limit
 * behavior. A PIN brute-force attack is inherently "many attempts against
 * ONE shop's staff", so that's the correct scope for the limit, not "many
 * attempts from one IP across every shop in the system" - the default
 * would let unrelated shops sharing a NAT/corporate egress IP rate-limit
 * each other, a real production gap, not just a test-suite artifact (this
 * surfaced when running the full test suite in one process: many
 * independent test files' staff logins, each for their OWN freshly-created
 * shop, were all sharing one IP-only counter and exhausting it well before
 * unrelated shops' logins should have been affected at all).
 */
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many login attempts, please try again later.' } },
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.shopId ?? 'unknown'}`,
});

router.post('/login', staffLoginLimiter, validateBody(staffLoginSchema), staffAuthController.login);
router.post('/logout', validateBody(staffLogoutSchema), staffAuthController.logout);

export default router;
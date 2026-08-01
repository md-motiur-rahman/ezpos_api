import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validateBody } from '../../middleware/validate.js';
import * as staffAuthController from './staffAuth.controller.js';
import { staffLoginSchema, staffLogoutSchema } from './staffAuth.validation.js';

const router = Router();

/**
 * Stricter than the global limiter (300/15min): an 8-digit PIN is weaker
 * than a password, and a till sits in a more exposed physical environment
 * than a website login.
 */
const staffLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many login attempts, please try again later.' } },
});

router.post('/login', staffLoginLimiter, validateBody(staffLoginSchema), staffAuthController.login);
router.post('/logout', validateBody(staffLogoutSchema), staffAuthController.logout);

export default router;
import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import {
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  confirmEmailChangeSchema,
} from './auth.validation.js';

const router = Router();

router.post('/register', validateBody(registerSchema), authController.register);
router.post('/verify-email', validateBody(verifyEmailSchema), authController.verifyEmail);
router.post(
  '/resend-verification',
  validateBody(resendVerificationSchema),
  authController.resendVerification
);
router.post('/login', validateBody(loginSchema), authController.login);
// No body: the refresh token travels as an HttpOnly cookie, not a request field.
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.post('/forgot-password', validateBody(forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', validateBody(resetPasswordSchema), authController.resetPassword);
router.post(
  '/confirm-email-change',
  validateBody(confirmEmailChangeSchema),
  authController.confirmEmailChange
);

export default router;
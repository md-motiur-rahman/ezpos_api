import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { registerSchema, verifyEmailSchema, resendVerificationSchema, loginSchema, refreshSchema, logoutSchema  } from './auth.validation.js';

const router = Router();

router.post('/register', validateBody(registerSchema), authController.register);
router.post('/verify-email', validateBody(verifyEmailSchema), authController.verifyEmail);
router.post(
  '/resend-verification',
  validateBody(resendVerificationSchema),
  authController.resendVerification
);
router.post('/login', validateBody(loginSchema), authController.login);
router.post('/refresh', validateBody(refreshSchema), authController.refresh);
router.post('/logout', validateBody(logoutSchema), authController.logout);

export default router;
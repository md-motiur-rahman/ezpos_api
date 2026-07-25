import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import * as authController from './auth.controller.js';
import { registerSchema, verifyEmailSchema, resendVerificationSchema } from './auth.validation.js';

const router = Router();

router.post('/register', validateBody(registerSchema), authController.register);
router.post('/verify-email', validateBody(verifyEmailSchema), authController.verifyEmail);
router.post(
  '/resend-verification',
  validateBody(resendVerificationSchema),
  authController.resendVerification
);

export default router;
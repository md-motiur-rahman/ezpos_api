import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validateBody } from '../../middleware/validate.js';
import * as meController from './me.controller.js';
import { updateProfileSchema, changePasswordSchema, changeEmailSchema } from './auth.validation.js';

const router = Router();

router.use(requireAuth);

router.get('/', meController.getProfile);
router.patch('/', validateBody(updateProfileSchema), meController.updateProfile);
router.post('/change-password', validateBody(changePasswordSchema), meController.changePassword);
router.post('/change-email', validateBody(changeEmailSchema), meController.changeEmail);

export default router;
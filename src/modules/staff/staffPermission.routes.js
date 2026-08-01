import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as staffPermissionController from './staffPermission.controller.js';
import {
  grantPermissionSchema,
  staffIdParamSchema,
  staffPermissionParamSchema,
} from './staffPermission.validation.js';

const router = Router();

router.use(requireStaffOrOwnerAuth);

router.post(
  '/:staffId',
  validateParams(staffIdParamSchema),
  validateBody(grantPermissionSchema),
  staffPermissionController.grantPermission
);
router.get('/:staffId', validateParams(staffIdParamSchema), staffPermissionController.listEffectivePermissions);
router.delete(
  '/:staffId/:permission',
  validateParams(staffPermissionParamSchema),
  staffPermissionController.revokePermission
);

export default router;
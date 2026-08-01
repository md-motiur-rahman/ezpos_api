import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as staffPermissionController from './staffPermission.controller.js';
import {
  grantPermissionSchema,
  staffIdParamSchema,
  staffPermissionParamSchema,
} from './staffPermission.validation.js';
import { shopIdOnlyParamSchema } from './staff.validation.js';
import { limitQuerySchema } from '../../utils/commonSchemas.js';

const router = Router();

router.use(requireStaffOrOwnerAuth);

// Registered ahead of the generic /:staffId routes below for readability
// (specific-before-generic, matching this project's usual convention) -
// verified empirically these two path shapes don't actually collide either
// way, since /:staffId only ever matches a single path segment.
router.get(
  '/shop/:shopId/audit-log',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(limitQuerySchema),
  staffPermissionController.listAuditLog
);

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
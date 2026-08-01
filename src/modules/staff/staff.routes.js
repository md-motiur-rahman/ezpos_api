import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as staffController from './staff.controller.js';
import {
  createStaffSchema,
  updateStaffSchema,
  staffIdParamSchema,
  shopIdOnlyParamSchema,
} from './staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/staff in app.js (Module 4.5) -
 * NOT nested under shop.routes.js. That router applies owner-only requireAuth
 * at its top, which would reject a staff session before it ever reached here,
 * regardless of what auth this router declared. Independent mounting is what
 * lets a Manager (a staff session) legitimately call these routes, same
 * reasoning as staffPermission.routes.js in 4.4.
 *
 * mergeParams: true is required here even though this is mounted directly on
 * the app (not nested inside another Router) - verified empirically that
 * :shopId from the mount path is NOT populated into req.params without it.
 *
 * Not behind requireActiveBilling: staff aren't a metered/billable resource
 * in this system (only shops and add-ons are).
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createStaffSchema),
  staffController.createStaff
);
router.get('/', validateParams(shopIdOnlyParamSchema), staffController.listStaff);
router.get('/:staffId', validateParams(staffIdParamSchema), staffController.getStaff);
router.patch(
  '/:staffId',
  validateParams(staffIdParamSchema),
  validateBody(updateStaffSchema),
  staffController.updateStaff
);
router.delete('/:staffId', validateParams(staffIdParamSchema), staffController.deactivateStaff);

export default router;
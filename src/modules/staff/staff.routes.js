import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
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
 * REVERSED, deliberately, not an oversight: this router previously stated
 * "not behind requireActiveBilling: staff aren't a metered/billable
 * resource" - true as far as it went (a staff row itself is never charged
 * for), but a separate later business decision widened billing enforcement
 * from "block only what adds a new billable thing" to "block real shop-floor
 * write actions once billing is locked," staff management included.
 * requireActiveBillingForShop below gates create/update/deactivate - reads
 * stay open regardless of billing state, same split as every other
 * newly-gated module.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(createStaffSchema),
  staffController.createStaff
);
router.get('/', validateParams(shopIdOnlyParamSchema), staffController.listStaff);
router.get('/:staffId', validateParams(staffIdParamSchema), staffController.getStaff);
router.patch(
  '/:staffId',
  requireActiveBillingForShop,
  validateParams(staffIdParamSchema),
  validateBody(updateStaffSchema),
  staffController.updateStaff
);
router.delete(
  '/:staffId',
  requireActiveBillingForShop,
  validateParams(staffIdParamSchema),
  staffController.deactivateStaff
);

export default router;
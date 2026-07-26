import { Router } from 'express';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as staffController from './staff.controller.js';
import {
  createStaffSchema,
  updateStaffSchema,
  staffIdParamSchema,
  shopIdOnlyParamSchema,
} from './staff.validation.js';

// mergeParams so :shopId from the parent router (/api/shops/:shopId/staff) is
// visible here. requireAuth is applied by the parent shop router.
//
// Not behind requireActiveBilling: staff aren't a metered/billable resource
// in this system (only shops and add-ons are).
const router = Router({ mergeParams: true });

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
import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as rotaController from './rota.controller.js';
import {
  createShiftSchema,
  updateShiftSchema,
  shiftIdParamSchema,
  dateRangeQuerySchema,
} from './rota.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/rota-shifts in app.js, same
 * pattern as staff.routes.js (4.5) - NOT nested under shop.routes.js's
 * owner-only requireAuth, so staff sessions (e.g. a Manager) can reach it.
 *
 * mergeParams: true is required even for this top-level mount - verified
 * empirically in 4.5 that Express doesn't populate :shopId without it.
 *
 * Not behind requireActiveBilling: the rota isn't a metered/billable
 * resource in this system.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createShiftSchema),
  rotaController.createShift
);
router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(dateRangeQuerySchema),
  rotaController.listShifts
);
router.get('/:shiftId', validateParams(shiftIdParamSchema), rotaController.getShift);
router.patch(
  '/:shiftId',
  validateParams(shiftIdParamSchema),
  validateBody(updateShiftSchema),
  rotaController.updateShift
);
router.delete('/:shiftId', validateParams(shiftIdParamSchema), rotaController.deleteShift);

export default router;
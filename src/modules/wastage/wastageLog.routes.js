import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as wastageLogController from './wastageLog.controller.js';
import { createWastageLogSchema, wastageLogIdParamSchema } from './wastageLog.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/wastage-logs in app.js, same
 * proven pattern as inventory-items (7.1), suppliers (7.4), and
 * purchase-orders (7.5/7.6). Both reading AND logging wastage require only
 * VIEW_INVENTORY - confirmed directly: unlike receiving (7.6), which
 * requires MANAGE_INVENTORY, wastage logging shares one permission gate
 * with reads, so a Chef (VIEW_INVENTORY by default) can log wastage too,
 * not just Managers.
 *
 * No PATCH, no DELETE - immutable once created, same reasoning as 7.6's
 * receipts: this represents an already-applied stock decrement. Correcting
 * a mistaken entry goes through 7.1's existing manual quantityOnHand
 * correction, not a reversal mechanism here.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createWastageLogSchema),
  wastageLogController.createWastageLog
);
router.get('/', validateParams(shopIdOnlyParamSchema), wastageLogController.listWastageLogs);
router.get(
  '/:wastageLogId',
  validateParams(wastageLogIdParamSchema),
  wastageLogController.getWastageLog
);

export default router;
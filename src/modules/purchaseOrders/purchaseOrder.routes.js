import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as purchaseOrderController from './purchaseOrder.controller.js';
import { createPurchaseOrderSchema, purchaseOrderIdParamSchema } from './purchaseOrder.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/purchase-orders in app.js,
 * same proven pattern as inventory-items (7.1) and suppliers (7.4). Same
 * permission pair: VIEW_INVENTORY to read, MANAGE_INVENTORY to log/delete -
 * purchase orders are inventory-adjacent, back-of-house data.
 *
 * Logging only - no PATCH route. Same shape as 4.6's staff audit log:
 * append-only, corrected by deleting and re-logging, not by editing
 * history in place.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createPurchaseOrderSchema),
  purchaseOrderController.createPurchaseOrder
);
router.get('/', validateParams(shopIdOnlyParamSchema), purchaseOrderController.listPurchaseOrders);
router.get('/:poId', validateParams(purchaseOrderIdParamSchema), purchaseOrderController.getPurchaseOrder);
router.delete(
  '/:poId',
  validateParams(purchaseOrderIdParamSchema),
  purchaseOrderController.deletePurchaseOrder
);

export default router;
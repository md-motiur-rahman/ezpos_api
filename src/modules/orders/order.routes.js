import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as orderController from './order.controller.js';
import { createOrderSchema, orderIdParamSchema } from './order.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/orders in app.js (9.1), same
 * proven pattern as inventory-items (7.1), wastage-logs (7.7), and
 * inventory-scans (8.2) - NOT nested under shop.routes.js's owner-only
 * requireAuth, so staff sessions can reach it.
 *
 * ACCESS_TILL gates every route here, including GET - same "reading and
 * creating share one permission gate" precedent as 7.7's wastage logs.
 * No PATCH, no DELETE - 9.4 (cancellation) and 9.5 (payment) will add
 * their own status-changing actions later; this submodule is creation +
 * read only.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createOrderSchema),
  orderController.createOrder
);
router.get('/', validateParams(shopIdOnlyParamSchema), orderController.listOrders);
router.get('/:orderId', validateParams(orderIdParamSchema), orderController.getOrder);

export default router;

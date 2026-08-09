import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as orderController from './order.controller.js';
import {
  createOrderSchema,
  orderIdParamSchema,
  addOrderItemsSchema,
  orderItemIdParamSchema,
  discountInputSchema,
  cancellationInputSchema,
  paymentInputSchema,
} from './order.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/orders in app.js (9.1), same
 * proven pattern as inventory-items (7.1), wastage-logs (7.7), and
 * inventory-scans (8.2) - NOT nested under shop.routes.js's owner-only
 * requireAuth, so staff sessions can reach it.
 *
 * ACCESS_TILL gates every route here, including GET - same "reading and
 * creating share one permission gate" precedent as 7.7's wastage logs -
 * except the discount routes (9.3), which are APPLY_DISCOUNT-gated instead.
 * No DELETE anywhere - cancellation/void (9.4) are their own explicit
 * actions, not a resource deletion, same "no reversal mechanism, correct
 * via a new action" philosophy as wastage/receipts.
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

// --- Adding items to an already-open order (9.2) ---

router.post(
  '/:orderId/items',
  validateParams(orderIdParamSchema),
  validateBody(addOrderItemsSchema),
  orderController.addItemsToOrder
);

// --- Discounts, order-level and per-line-item (9.3) ---

router.patch(
  '/:orderId/discount',
  validateParams(orderIdParamSchema),
  validateBody(discountInputSchema),
  orderController.setOrderDiscount
);

router.patch(
  '/:orderId/items/:orderItemId/discount',
  validateParams(orderItemIdParamSchema),
  validateBody(discountInputSchema),
  orderController.setOrderItemDiscount
);

// --- Cancellation (whole order) and void (single line item) (9.4) ---

router.post(
  '/:orderId/cancel',
  validateParams(orderIdParamSchema),
  validateBody(cancellationInputSchema),
  orderController.cancelOrder
);

router.post(
  '/:orderId/items/:orderItemId/void',
  validateParams(orderItemIdParamSchema),
  validateBody(cancellationInputSchema),
  orderController.voidOrderItem
);

// --- Payments, cash and card, split/partial (9.5) ---

// One call per payment - splitting a bill is simply calling this more than
// once, same "multiple receipts per PO" precedent as 7.6.
router.post(
  '/:orderId/payments',
  validateParams(orderIdParamSchema),
  validateBody(paymentInputSchema),
  orderController.recordPayment
);

export default router;

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
  paymentIdParamSchema,
  refundInputSchema,
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
 * except the discount routes (9.3) and the refund route (9.6), which are
 * APPLY_DISCOUNT-gated instead.
 * No DELETE anywhere - cancellation/void (9.4) are their own explicit
 * actions, not a resource deletion, and a refund (9.6) is a new record
 * rather than the removal of a payment, same "no reversal mechanism,
 * correct via a new action" philosophy as wastage/receipts.
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

// --- Refunds, per payment, full or partial (9.6) ---

// Hangs off the PAYMENT being refunded, not the order - a refund always
// reverses one specific payment (a card charge can only be returned to that
// card). Partial refunds are simply calling this more than once against the
// same payment. No route-ordering hazard with '/:orderId/payments' above:
// that one is POST on a strictly shorter path, so neither can swallow the
// other the way a literal segment and a ':param' at the SAME depth would
// (the /latest-before-/:scanId lesson from 8.3).
router.post(
  '/:orderId/payments/:paymentId/refund',
  validateParams(paymentIdParamSchema),
  validateBody(refundInputSchema),
  orderController.refundPayment
);

export default router;

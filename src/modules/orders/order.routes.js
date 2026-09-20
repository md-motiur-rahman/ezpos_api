import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
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
  syncOfflineOrderSchema,
  orderItemStatusInputSchema,
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
 *
 * requireActiveBillingForShop gates every real till write here (create
 * order, add items, both discount routes, cancel, void, payments, refund) -
 * a business decision, applied deliberately per-route rather than at the
 * router level, with two routes just as deliberately left off it: /sync
 * (an offline sale already happened and was already paid for on the
 * device - blocking its sync would strand a real, completed transaction
 * behind a billing problem the till operator can't fix from a device with
 * no connectivity) and the item-status route (a kitchen/KDS action, not a
 * revenue one - see its own comment below).
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(createOrderSchema),
  orderController.createOrder
);
router.get('/', validateParams(shopIdOnlyParamSchema), orderController.listOrders);

// --- Offline sync (9.7) ---

// Registered BEFORE '/:orderId' below. Strictly speaking the two cannot
// collide today - this is a POST and that is a GET - but the literal
// segment goes first regardless, following the same discipline as 8.3's
// '/latest' before '/:scanId' and app.js's mount ordering: relying on the
// methods differing would silently become a bug the day anyone adds a
// GET /orders/sync or a POST /orders/:orderId, and the ordering costs
// nothing to get right now.
//
// A POST, not a PUT, even though it is idempotent: it creates a resource,
// and the idempotency key lives in the body rather than the URL (there is
// no server-side path for a client-generated id). Replays are answered 200
// vs a first sync's 201 - see the controller.
//
// Deliberately NOT behind requireActiveBillingForShop, unlike every other
// write below - see this file's own module doc for why: the sale already
// happened and was already paid for on a device with no connectivity;
// blocking the sync would strand a real, completed transaction rather than
// prevent a new billable one.
router.post(
  '/sync',
  validateParams(shopIdOnlyParamSchema),
  validateBody(syncOfflineOrderSchema),
  orderController.syncOfflineOrder
);

router.get('/:orderId', validateParams(orderIdParamSchema), orderController.getOrder);

// --- Adding items to an already-open order (9.2) ---

router.post(
  '/:orderId/items',
  requireActiveBillingForShop,
  validateParams(orderIdParamSchema),
  validateBody(addOrderItemsSchema),
  orderController.addItemsToOrder
);

// --- Discounts, order-level and per-line-item (9.3) ---

router.patch(
  '/:orderId/discount',
  requireActiveBillingForShop,
  validateParams(orderIdParamSchema),
  validateBody(discountInputSchema),
  orderController.setOrderDiscount
);

router.patch(
  '/:orderId/items/:orderItemId/discount',
  requireActiveBillingForShop,
  validateParams(orderItemIdParamSchema),
  validateBody(discountInputSchema),
  orderController.setOrderItemDiscount
);

// --- Cancellation (whole order) and void (single line item) (9.4) ---

router.post(
  '/:orderId/cancel',
  requireActiveBillingForShop,
  validateParams(orderIdParamSchema),
  validateBody(cancellationInputSchema),
  orderController.cancelOrder
);

router.post(
  '/:orderId/items/:orderItemId/void',
  requireActiveBillingForShop,
  validateParams(orderItemIdParamSchema),
  validateBody(cancellationInputSchema),
  orderController.voidOrderItem
);

// --- Item status flow (10.2) ---

// VIEW_KDS-gated, not ACCESS_TILL - this is a kitchen action, and the Chef
// (this permission's primary holder) has no till access. A PATCH, same verb
// as 9.3's discount routes: this sets a field to an explicit value rather
// than performing a one-directional business action the way cancel/void do.
// Deliberately NOT behind requireActiveBillingForShop: this updates a
// kitchen prep status on food already ordered and (usually) already paid
// for, not a new billable action - a kitchen mid-service shouldn't have its
// own workflow interrupted by a billing problem it has no way to fix.
router.patch(
  '/:orderId/items/:orderItemId/status',
  validateParams(orderItemIdParamSchema),
  validateBody(orderItemStatusInputSchema),
  orderController.setOrderItemStatus
);

// --- Payments, cash and card, split/partial (9.5) ---

// One call per payment - splitting a bill is simply calling this more than
// once, same "multiple receipts per PO" precedent as 7.6.
router.post(
  '/:orderId/payments',
  requireActiveBillingForShop,
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
  requireActiveBillingForShop,
  validateParams(paymentIdParamSchema),
  validateBody(refundInputSchema),
  orderController.refundPayment
);

export default router;

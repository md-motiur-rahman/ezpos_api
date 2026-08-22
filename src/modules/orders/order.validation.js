import { z } from 'zod';
import { ORDER_TYPES, DISCOUNT_TYPES, PAYMENT_METHODS } from './orderConstants.js';

const orderItemSchema = z
  .object({
    menuItemId: z.string().uuid('Invalid menu item id').optional(),
    shopMenuItemId: z.string().uuid('Invalid shop menu item id').optional(),
    variantId: z.string().uuid('Invalid variant id').optional(),
    modifierOptionIds: z.array(z.string().uuid('Invalid modifier option id')).optional(),
    quantity: z.number().int('quantity must be a whole number').positive('quantity must be greater than 0'),
  })
  // Exactly one of menuItemId/shopMenuItemId - same master/local split
  // enforced at the app layer throughout Module 6/7, not a DB constraint.
  .refine((item) => Boolean(item.menuItemId) !== Boolean(item.shopMenuItemId), {
    message: 'Provide exactly one of menuItemId or shopMenuItemId',
    path: ['menuItemId'],
  });

export const createOrderSchema = z
  .object({
    type: z.enum(ORDER_TYPES),
    tableNumber: z.string().trim().min(1, 'tableNumber cannot be empty').optional(),
    customerName: z.string().trim().min(1, 'customerName cannot be empty').optional(),
    items: z.array(orderItemSchema).min(1, 'An order must have at least one item'),
  })
  // tableNumber is required for dine_in (confirmed directly - "dine-in/
  // table" in the roadmap) and must be absent for takeaway, where it has
  // no meaning.
  .refine((data) => (data.type === 'dine_in' ? Boolean(data.tableNumber) : true), {
    message: 'tableNumber is required for dine_in orders',
    path: ['tableNumber'],
  })
  .refine((data) => (data.type === 'takeaway' ? !data.tableNumber : true), {
    message: 'tableNumber is not valid for takeaway orders',
    path: ['tableNumber'],
  });

export const orderIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  orderId: z.string().uuid('Invalid order id'),
});

// --- Adding items to an already-open order (9.2) ---

// Reuses the exact same per-item shape as createOrderSchema's items array -
// no new rules, just a different endpoint to apply them at.
export const addOrderItemsSchema = z.object({
  items: z.array(orderItemSchema).min(1, 'Provide at least one item to add'),
});

// --- Discounts, order-level and per-line-item (9.3) ---

export const orderItemIdParamSchema = orderIdParamSchema.extend({
  orderItemId: z.string().uuid('Invalid order item id'),
});

const setDiscountSchema = z
  .object({
    discountType: z.enum(DISCOUNT_TYPES),
    discountValue: z.number().positive('discountValue must be greater than 0'),
    reason: z.string().trim().min(1, 'reason cannot be empty').optional(),
  })
  .refine((data) => (data.discountType === 'percentage' ? data.discountValue <= 100 : true), {
    message: 'A percentage discount cannot exceed 100',
    path: ['discountValue'],
  });

// Explicit null clears an existing discount - same "explicit null clears,
// omitted leaves untouched" contract as 7.3/8.1, applied here to a whole
// discount rather than a single field: both discountType and discountValue
// must be null together, since one without the other is meaningless.
const clearDiscountSchema = z.object({
  discountType: z.null(),
  discountValue: z.null(),
});

export const discountInputSchema = z.union([setDiscountSchema, clearDiscountSchema]);

// --- Cancellation (whole order) and void (single line item) (9.4) ---

// Same shape for both actions - reused as-is, same "one input schema, two
// endpoints" pattern as discountInputSchema above. wasPrepped is REQUIRED,
// not optional or defaulted: no KDS exists yet to detect prep state
// automatically, so this is a staff declaration that must be explicit
// (confirmed directly), never silently assumed either way.
export const cancellationInputSchema = z.object({
  wasPrepped: z.boolean(),
  reason: z.string().trim().min(1, 'reason cannot be empty').optional(),
});

// --- Payments, cash and card, split/partial (9.5) ---

// Cash and card take genuinely different inputs, so this is a discriminated
// union rather than one object with two optional fields: it makes the
// REQUIRED field method-specific (cash without amountTendered, or card
// without amount, is rejected), which a single object with two optionals
// could not express. Unknown extra keys are stripped, not rejected - same
// non-strict behaviour as every other schema in this project.
//
// Cash uses amountTendered (what the customer physically handed over, which
// MAY exceed what's owed - confirmed directly); card uses amount (what to
// charge, which may NOT exceed what's owed, since there's nothing to give
// change from).
const cashPaymentSchema = z.object({
  method: z.literal('cash'),
  amountTendered: z.number().positive('amountTendered must be greater than 0'),
});

const cardPaymentSchema = z.object({
  method: z.literal('card'),
  amount: z.number().positive('amount must be greater than 0'),
});

export const paymentInputSchema = z.discriminatedUnion('method', [
  cashPaymentSchema,
  cardPaymentSchema,
]);

// --- Refunds, per payment, full or partial (9.6) ---

export const paymentIdParamSchema = orderIdParamSchema.extend({
  paymentId: z.string().uuid('Invalid payment id'),
});

// Deliberately NOT a discriminated union like paymentInputSchema above -
// a refund's input is identical for cash and card, because the METHOD is
// never supplied by the caller: it's taken from the payment being refunded
// (order_refunds has no method column of its own - "derive, don't store").
// A caller cannot ask to refund a card payment as cash.
//
// `amount` is always required and always explicit - there is no "refund
// the whole thing" shorthand, deliberately: refunding is a money-out
// action, so the amount the staff member intends is stated rather than
// inferred. It's validated at issue time against the payment's own
// remaining refundable balance (see refundPayment in the service).
export const refundInputSchema = z.object({
  amount: z.number().positive('amount must be greater than 0'),
  reason: z.string().trim().min(1, 'reason cannot be empty').optional(),
});

// --- Offline sync (9.7) ---

/**
 * One already-completed offline line.
 *
 * DELIBERATELY a different shape from orderItemSchema above, and the
 * difference is the whole point of 9.7: an online order sends only WHAT was
 * ordered and lets the server resolve the price from the live menu
 * (resolveOrderLine), whereas an offline order sends the price the customer
 * was ACTUALLY CHARGED on the device, against whatever menu that device had
 * cached at the time. Confirmed directly: the server trusts that snapshot as
 * historical fact rather than re-deriving it, because the cash has already
 * changed hands - silently re-pricing a completed sale would make the synced
 * record disagree with the receipt the customer is holding.
 *
 * So `unitPrice` is REQUIRED here (it is never sent for an online order),
 * and modifiers are objects carrying their own `priceDelta` rather than the
 * bare `modifierOptionIds` array an online order sends.
 */
const offlineOrderItemSchema = z
  .object({
    menuItemId: z.string().uuid('Invalid menu item id').optional(),
    shopMenuItemId: z.string().uuid('Invalid shop menu item id').optional(),
    variantId: z.string().uuid('Invalid variant id').optional(),
    quantity: z.number().int('quantity must be a whole number').positive('quantity must be greater than 0'),
    // nonnegative, not positive: a genuinely free line (a comped side, a
    // £0.00 promotional item) is a real thing a till can ring up, and this
    // is a historical record of what was charged, not a price being set.
    unitPrice: z.number().nonnegative('unitPrice cannot be negative'),
    modifiers: z
      .array(
        z.object({
          modifierOptionId: z.string().uuid('Invalid modifier option id'),
          // Signed on purpose - a modifier delta may legitimately be
          // negative (e.g. "no cheese, -£0.50"), exactly as the live
          // modifier_options price it snapshots may be.
          priceDelta: z.number(),
        })
      )
      .optional(),
  })
  .refine((item) => Boolean(item.menuItemId) !== Boolean(item.shopMenuItemId), {
    message: 'Provide exactly one of menuItemId or shopMenuItemId',
    path: ['menuItemId'],
  });

/**
 * A queued offline sale.
 *
 * `payment` is REQUIRED, not optional (scope decision, flagged rather than
 * assumed): the roadmap names this a "cash-order QUEUE", i.e. a queue of
 * COMPLETED transactions. An offline order with no payment taken has no
 * reason to have been queued at all - nothing was charged, so it can simply
 * be rung up normally through 9.1's POST /orders once connectivity returns.
 * Requiring it also keeps the idempotency contract crisp: one sync call
 * represents exactly one finished sale.
 *
 * It reuses paymentInputSchema (9.5) UNCHANGED rather than defining its own
 * cash/card shape - same discriminated union, same method-specific required
 * fields, so a queued payment is validated identically to a live one.
 */
export const syncOfflineOrderSchema = z
  .object({
    // The device's own idempotency key. Bounded in length only - see the
    // migration for why its FORMAT is deliberately not constrained to a
    // uuid: it is the client's identifier for its own queue entry, and
    // dictating its shape would be overreach.
    clientOrderId: z
      .string()
      .trim()
      .min(1, 'clientOrderId cannot be empty')
      .max(200, 'clientOrderId is too long'),
    // When the sale happened ON THE DEVICE. Required: without it a synced
    // order would be indistinguishable from one rung up at sync time, and
    // 12.x reporting would attribute an offline day's takings to whenever
    // the till next found signal.
    occurredAt: z.string().datetime({ offset: true, message: 'occurredAt must be an ISO 8601 datetime' }),
    type: z.enum(ORDER_TYPES),
    tableNumber: z.string().trim().min(1, 'tableNumber cannot be empty').optional(),
    customerName: z.string().trim().min(1, 'customerName cannot be empty').optional(),
    items: z.array(offlineOrderItemSchema).min(1, 'An order must have at least one item'),
    payment: paymentInputSchema,
  })
  // Identical dine_in/takeaway rules to createOrderSchema - an order that
  // happened offline is still the same kind of order, so it is held to the
  // same structural rules. Restated rather than shared because
  // createOrderSchema's refinements are attached to that specific object
  // shape, which this one deliberately differs from (see above).
  .refine((data) => (data.type === 'dine_in' ? Boolean(data.tableNumber) : true), {
    message: 'tableNumber is required for dine_in orders',
    path: ['tableNumber'],
  })
  .refine((data) => (data.type === 'takeaway' ? !data.tableNumber : true), {
    message: 'tableNumber is not valid for takeaway orders',
    path: ['tableNumber'],
  });

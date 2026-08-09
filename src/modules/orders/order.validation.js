import { z } from 'zod';
import { ORDER_TYPES, DISCOUNT_TYPES } from './orderConstants.js';

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

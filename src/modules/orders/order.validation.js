import { z } from 'zod';
import { ORDER_TYPES } from './orderConstants.js';

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

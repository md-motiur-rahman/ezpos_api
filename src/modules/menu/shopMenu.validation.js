import { z } from 'zod';
import { createItemSchema, updateItemSchema } from './menu.validation.js';

// Local shop items share 6.1's exact item body shape (categoryId, name,
// description, price, displayOrder) - genuinely identical fields, so these
// are reused directly rather than redefined.
export const createLocalItemSchema = createItemSchema;
export const updateLocalItemSchema = updateItemSchema;

export const localItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid item id'),
});

// Fully clearing an override (both fields, back to master defaults) is
// DELETE's job - PATCH only ever sets a field, never explicitly nulls one,
// so priceOverride here is a plain positive number, not nullable.
export const overrideSchema = z.object({
  isEnabled: z.boolean().optional(),
  priceOverride: z.number().positive('priceOverride must be greater than 0').optional(),
});

export const menuItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  menuItemId: z.string().uuid('Invalid menu item id'),
});

// variantOverrideSchema is intentionally just overrideSchema reused - same
// { isEnabled?, priceOverride? } shape, one level down.
export const variantOverrideSchema = overrideSchema;

export const variantIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  variantId: z.string().uuid('Invalid variant id'),
});
import { z } from 'zod';
import { createItemSchema, updateItemSchema } from './menu.validation.js';

export const createLocalItemSchema = createItemSchema;
export const updateLocalItemSchema = updateItemSchema;

export const localItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid item id'),
});

export const overrideSchema = z.object({
  isEnabled: z.boolean().optional(),
  priceOverride: z.number().positive('priceOverride must be greater than 0').optional(),
});

export const menuItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  menuItemId: z.string().uuid('Invalid menu item id'),
});

export const variantOverrideSchema = overrideSchema;

export const variantIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  variantId: z.string().uuid('Invalid variant id'),
});

// --- Modifiers (6.4) ---

export const modifierOptionOverrideSchema = z.object({
  isEnabled: z.boolean().optional(),
  priceDeltaOverride: z.number().finite().optional(),
});

export const modifierOptionIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  optionId: z.string().uuid('Invalid modifier option id'),
});

export const localItemModifierGroupParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid item id'),
  groupId: z.string().uuid('Invalid modifier group id'),
});

// --- Ingredients / allergens (6.5) ---

export const localItemIngredientParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid item id'),
  ingredientId: z.string().uuid('Invalid ingredient id'),
});
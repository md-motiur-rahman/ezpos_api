import { z } from 'zod';
import { ALLERGENS } from './allergens.js';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required'),
  displayOrder: z.number().int().optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').optional(),
  displayOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

export const categoryIdParamSchema = z.object({
  categoryId: z.string().uuid('Invalid category id'),
});

export const createItemSchema = z.object({
  categoryId: z.string().uuid('Invalid category id'),
  name: z.string().trim().min(1, 'Item name is required'),
  description: z.string().trim().optional(),
  price: z.number().positive('Price must be greater than 0'),
  displayOrder: z.number().int().optional(),
});

export const updateItemSchema = z.object({
  categoryId: z.string().uuid('Invalid category id').optional(),
  name: z.string().trim().min(1, 'Item name is required').optional(),
  description: z.string().trim().optional(),
  price: z.number().positive('Price must be greater than 0').optional(),
  displayOrder: z.number().int().optional(),
});

export const itemIdParamSchema = z.object({
  itemId: z.string().uuid('Invalid item id'),
});

export const itemListQuerySchema = z.object({
  categoryId: z.string().uuid('Invalid category id').optional(),
});

// --- Variants (6.3) ---

export const createVariantSchema = z.object({
  name: z.string().trim().min(1, 'Variant name is required'),
  price: z.number().positive('Price must be greater than 0'),
  displayOrder: z.number().int().optional(),
});

export const updateVariantSchema = z.object({
  name: z.string().trim().min(1, 'Variant name is required').optional(),
  price: z.number().positive('Price must be greater than 0').optional(),
  displayOrder: z.number().int().optional(),
});

export const variantIdParamSchema = z.object({
  itemId: z.string().uuid('Invalid item id'),
  variantId: z.string().uuid('Invalid variant id'),
});

// --- Modifiers (6.4) ---

export const createModifierGroupSchema = z
  .object({
    name: z.string().trim().min(1, 'Group name is required'),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z.number().int().min(1).optional(),
  })
  .refine((data) => (data.minSelections ?? 0) <= (data.maxSelections ?? 1), {
    message: 'minSelections cannot be greater than maxSelections',
    path: ['minSelections'],
  });

export const updateModifierGroupSchema = z
  .object({
    name: z.string().trim().min(1, 'Group name is required').optional(),
    minSelections: z.number().int().min(0).optional(),
    maxSelections: z.number().int().min(1).optional(),
  })
  .refine(
    (data) =>
      data.minSelections === undefined ||
      data.maxSelections === undefined ||
      data.minSelections <= data.maxSelections,
    {
      message: 'minSelections cannot be greater than maxSelections',
      path: ['minSelections'],
    }
  );

export const modifierGroupIdParamSchema = z.object({
  groupId: z.string().uuid('Invalid modifier group id'),
});

export const createModifierOptionSchema = z.object({
  name: z.string().trim().min(1, 'Option name is required'),
  // A delta, not an absolute price - can legitimately be negative, zero, or
  // positive, so no .positive() constraint here.
  priceDelta: z.number().finite().optional(),
  displayOrder: z.number().int().optional(),
});

export const updateModifierOptionSchema = z.object({
  name: z.string().trim().min(1, 'Option name is required').optional(),
  priceDelta: z.number().finite().optional(),
  displayOrder: z.number().int().optional(),
});

export const modifierOptionIdParamSchema = z.object({
  groupId: z.string().uuid('Invalid modifier group id'),
  optionId: z.string().uuid('Invalid modifier option id'),
});

export const itemModifierGroupParamSchema = z.object({
  itemId: z.string().uuid('Invalid item id'),
  groupId: z.string().uuid('Invalid modifier group id'),
});

// --- Ingredients / allergens (6.5) ---

export const createIngredientSchema = z.object({
  name: z.string().trim().min(1, 'Ingredient name is required'),
  allergens: z.array(z.enum(ALLERGENS)).optional(),
});

export const updateIngredientSchema = z.object({
  name: z.string().trim().min(1, 'Ingredient name is required').optional(),
  allergens: z.array(z.enum(ALLERGENS)).optional(),
});

export const ingredientIdParamSchema = z.object({
  ingredientId: z.string().uuid('Invalid ingredient id'),
});

export const itemIngredientParamSchema = z.object({
  itemId: z.string().uuid('Invalid item id'),
  ingredientId: z.string().uuid('Invalid ingredient id'),
});
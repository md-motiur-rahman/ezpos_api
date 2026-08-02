import { z } from 'zod';

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
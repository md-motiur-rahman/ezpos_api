import { z } from 'zod';

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required'),
  unit: z.string().trim().min(1, 'Unit is required'),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
});

export const updateInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').optional(),
  unit: z.string().trim().min(1, 'Unit is required').optional(),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
});

export const inventoryItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid inventory item id'),
});
import { z } from 'zod';

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required'),
  unit: z.string().trim().min(1, 'Unit is required'),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
  lowStockThreshold: z.number().min(0, 'lowStockThreshold cannot be negative').optional(),
});

export const updateInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').optional(),
  unit: z.string().trim().min(1, 'Unit is required').optional(),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
  // Nullable AND optional, deliberately different from the other fields:
  // omitting this key leaves the threshold untouched, but explicitly
  // sending `null` clears it back to "not tracked for alerting" - the same
  // "explicit null clears, omitted leaves alone" contract buildUpdateSet
  // already relies on everywhere else in this project.
  lowStockThreshold: z.number().min(0, 'lowStockThreshold cannot be negative').nullable().optional(),
});

export const inventoryItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid inventory item id'),
});

// Query params always arrive as strings - explicit 'true'/'false' enum
// rather than z.coerce.boolean(), which would incorrectly treat the
// literal string "false" as truthy (Boolean("false") === true in JS).
export const inventoryListQuerySchema = z.object({
  lowStockOnly: z.enum(['true', 'false']).optional(),
});
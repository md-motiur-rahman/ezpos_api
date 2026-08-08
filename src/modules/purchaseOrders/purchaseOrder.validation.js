import { z } from 'zod';

const purchaseOrderItemSchema = z.object({
  inventoryItemId: z.string().uuid('Invalid inventory item id'),
  quantity: z.number().positive('quantity must be greater than 0'),
  unitCost: z.number().min(0, 'unitCost cannot be negative').optional(),
});

export const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid('Invalid supplier id'),
  // Optional - defaults to now() at the DB layer if omitted. Accepting an
  // explicit value is what makes this a genuine LOG, not just "orders
  // placed through this system" - a past order can be backdated.
  orderedAt: z.string().datetime({ message: 'orderedAt must be an ISO 8601 datetime' }).optional(),
  notes: z.string().trim().optional(),
  items: z
    .array(purchaseOrderItemSchema)
    .min(1, 'A purchase order must have at least one line item')
    .refine(
      (items) => new Set(items.map((i) => i.inventoryItemId)).size === items.length,
      { message: 'Duplicate inventoryItemId in items - each item should appear once, with one quantity' }
    ),
});

export const purchaseOrderIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  poId: z.string().uuid('Invalid purchase order id'),
});

// --- Stock receiving (7.6) ---

const receiptItemSchema = z.object({
  purchaseOrderItemId: z.string().uuid('Invalid purchase order item id'),
  // Deliberately no upper bound tied to the ordered quantity - over- and
  // under-delivery are real scenarios this module needs to FLAG, not
  // silently prevent by capping the input.
  quantityReceived: z.number().positive('quantityReceived must be greater than 0'),
});

export const createReceiptSchema = z.object({
  // Optional - defaults to now() at the DB layer if omitted, same
  // backdating precedent as purchase_orders.ordered_at (7.5).
  receivedAt: z.string().datetime({ message: 'receivedAt must be an ISO 8601 datetime' }).optional(),
  notes: z.string().trim().optional(),
  items: z
    .array(receiptItemSchema)
    .min(1, 'A receipt must have at least one line item')
    .refine(
      (items) => new Set(items.map((i) => i.purchaseOrderItemId)).size === items.length,
      { message: 'Duplicate purchaseOrderItemId in items - each line should appear once per receipt' }
    ),
});
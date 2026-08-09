import { z } from 'zod';
import { WASTAGE_REASONS } from './wastageReasons.js';

const wastageLogItemSchema = z.object({
  inventoryItemId: z.string().uuid('Invalid inventory item id'),
  quantityWasted: z.number().positive('quantityWasted must be greater than 0'),
  reason: z.enum(WASTAGE_REASONS),
  notes: z.string().trim().optional(),
});

export const createWastageLogSchema = z.object({
  // Optional - defaults to now() at the DB layer if omitted, same
  // backdating precedent as purchase_orders.ordered_at (7.5) and
  // purchase_order_receipts.received_at (7.6).
  wastedAt: z.string().datetime({ message: 'wastedAt must be an ISO 8601 datetime' }).optional(),
  notes: z.string().trim().optional(),
  items: z
    .array(wastageLogItemSchema)
    .min(1, 'A wastage log must have at least one line item')
    .refine(
      (items) => new Set(items.map((i) => i.inventoryItemId)).size === items.length,
      {
        message:
          'Duplicate inventoryItemId in items - log the same item wasted for two different reasons as two separate entries',
      }
    ),
});

export const wastageLogIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  wastageLogId: z.string().uuid('Invalid wastage log id'),
});
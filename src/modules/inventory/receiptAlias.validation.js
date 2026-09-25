import { z } from 'zod';

export const saveReceiptAliasesSchema = z.object({
  aliases: z
    .array(
      z.object({
        wording: z.string().trim().min(1, 'wording is required').max(200, 'wording is too long'),
        inventoryItemId: z.string().uuid('Invalid inventory item id'),
      })
    )
    .min(1, 'Send at least one alias')
    .max(100, 'Too many aliases in one request'),
});

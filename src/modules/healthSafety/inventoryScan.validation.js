import { z } from 'zod';
import { SCAN_STATES } from './scanStates.js';

export const createScanSchema = z.object({
  sku: z.string().trim().min(1, 'sku is required'),
  state: z.enum(SCAN_STATES),
});

export const scanIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  scanId: z.string().uuid('Invalid scan id'),
});

// --- Resolutions (8.4) ---

// wastageLogId is OPTIONAL, deliberately - a flag can be resolved either
// by pointing at the 7.7 wastage log that disposed of the item, or
// dismissed with no wastage behind it at all (false alarm, already used
// up, mis-scanned).
export const resolveScanSchema = z.object({
  wastageLogId: z.string().uuid('Invalid wastage log id').optional(),
  notes: z.string().trim().min(1, 'notes cannot be empty').optional(),
});

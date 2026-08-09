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

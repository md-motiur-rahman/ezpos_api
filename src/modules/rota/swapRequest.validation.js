import { z } from 'zod';

export const createSwapRequestSchema = z.object({
  shiftId: z.string().uuid('Invalid shift id'),
  toStaffId: z.string().uuid('Invalid staff id'),
  notes: z.string().trim().optional(),
});

export const requestIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  requestId: z.string().uuid('Invalid request id'),
});

export const statusQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
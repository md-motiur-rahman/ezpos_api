import { z } from 'zod';

export const createSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required'),
  contactName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().email('Invalid email address').optional(),
  notes: z.string().trim().optional(),
});

export const updateSupplierSchema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').optional(),
  contactName: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  email: z.string().trim().email('Invalid email address').optional(),
  notes: z.string().trim().optional(),
});

export const supplierIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  supplierId: z.string().uuid('Invalid supplier id'),
});
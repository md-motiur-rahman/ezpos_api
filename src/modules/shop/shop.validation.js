import { z } from 'zod';

export const createShopSchema = z.object({
  name: z.string().trim().min(1, 'Shop name is required'),
  addressLine1: z.string().trim().min(1, 'Address is required'),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().min(1, 'City is required'),
  postcode: z.string().trim().min(1, 'Postcode is required'),
  country: z.string().trim().min(1, 'Country is required'),
  phone: z.string().trim().min(1, 'Phone number is required'),
  kdsEnabled: z.boolean().optional(),
  rotaEnabled: z.boolean().optional(),
  vatRegistered: z.boolean(),
  defaultVatRate: z.number().min(0).max(100).optional(),
});

export const updateShopSchema = createShopSchema.partial();

export const shopIdParamSchema = z.object({
  id: z.string().uuid('Invalid shop id'),
});
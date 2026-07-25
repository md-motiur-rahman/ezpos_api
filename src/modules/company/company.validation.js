import { z } from 'zod';

export const createCompanySchema = z.object({
  name: z.string().trim().min(1, 'Company name is required'),
  addressLine1: z.string().trim().min(1, 'Address is required'),
  addressLine2: z.string().trim().optional(),
  city: z.string().trim().min(1, 'City is required'),
  postcode: z.string().trim().min(1, 'Postcode is required'),
  country: z.string().trim().min(1, 'Country is required'),
  phone: z.string().trim().min(1, 'Phone number is required'),
  vatNumber: z.string().trim().optional(),
  companyNumber: z.string().trim().optional(),
});

export const updateCompanySchema = createCompanySchema.partial();
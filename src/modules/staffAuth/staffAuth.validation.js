import { z } from 'zod';

export const staffLoginSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  staffIdCode: z.string().regex(/^\d{8}$/, 'Staff ID must be 8 digits'),
  pin: z.string().regex(/^\d{8}$/, 'PIN must be 8 digits'),
});

export const staffLogoutSchema = z.object({
  sessionToken: z.string().min(1, 'sessionToken is required'),
});
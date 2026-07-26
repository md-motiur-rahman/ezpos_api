import { z } from 'zod';
import { ROLES } from './permissions.js';

// Staff roles exclude 'owner' - the Owner is never a staff row.
const STAFF_ROLES = Object.values(ROLES).filter((role) => role !== ROLES.OWNER);

export const createStaffSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  role: z.enum(STAFF_ROLES),
});

export const updateStaffSchema = createStaffSchema.partial();

export const staffIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  staffId: z.string().uuid('Invalid staff id'),
});

export const shopIdOnlyParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
});
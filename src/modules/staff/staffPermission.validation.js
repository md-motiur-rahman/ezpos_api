import { z } from 'zod';
import { PERMISSIONS } from './permissions.js';

const PERMISSION_VALUES = Object.values(PERMISSIONS);

export const grantPermissionSchema = z.object({
  permission: z.enum(PERMISSION_VALUES),
});

export const staffIdParamSchema = z.object({
  staffId: z.string().uuid('Invalid staff id'),
});

export const staffPermissionParamSchema = z.object({
  staffId: z.string().uuid('Invalid staff id'),
  permission: z.enum(PERMISSION_VALUES),
});
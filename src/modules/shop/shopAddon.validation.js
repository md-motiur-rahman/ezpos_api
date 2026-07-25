import { z } from 'zod';

/** Add types the platform sells. Adding one here + an env price id is all it takes. */
export const ADDON_TYPES = ['health_safety'];

export const activateAddonSchema = z.object({
  addonType: z.enum(ADDON_TYPES),
});

/** Nested under /api/shops/:shopId/addons - shopId comes through via mergeParams. */
export const shopIdParamsSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
});

export const addonParamsSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  addonType: z.enum(ADDON_TYPES),
});
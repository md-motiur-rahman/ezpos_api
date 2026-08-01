import { z } from 'zod';

/**
 * A `?limit=` query param, 1-100, defaulting to 10. Reused anywhere a list
 * endpoint needs a simple bounded page size (3.7's billing history, 4.6's
 * audit log, and likely future modules - reporting, order history, ...)
 * rather than each one defining its own identical copy.
 */
export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
});
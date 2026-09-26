import { z } from 'zod';

const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

/**
 * The kitchen log's time window. The caller sends real instants (the browser
 * knows where its own midnight is), so "today" means the shop's day, not the
 * server's. Capped at 31 days so one request can't ask for everything.
 */
export const kdsHistoryQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true, message: 'from must be an ISO 8601 datetime' }),
    to: z.string().datetime({ offset: true, message: 'to must be an ISO 8601 datetime' }),
  })
  .refine((q) => new Date(q.to) > new Date(q.from), { message: 'to must be after from' })
  .refine((q) => new Date(q.to) - new Date(q.from) <= MAX_WINDOW_MS, {
    message: 'The window can be at most 31 days',
  });

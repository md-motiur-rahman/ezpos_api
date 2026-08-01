import { z } from 'zod';

// Both required deliberately - no unbounded "everything ever" default, same
// convention as 5.1's rota date-range query. Reused as-is by the comparison
// endpoint too, since it needs the identical shape.
export const attendanceListQuerySchema = z
  .object({
    staffId: z.string().uuid('Invalid staff id').optional(),
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((data) => data.to > data.from, {
    message: 'to must be after from',
    path: ['to'],
  });

export const attendanceRecordIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  recordId: z.string().uuid('Invalid record id'),
});
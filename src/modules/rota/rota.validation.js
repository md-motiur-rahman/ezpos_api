import { z } from 'zod';

export const createShiftSchema = z
  .object({
    staffId: z.string().uuid('Invalid staff id'),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
    notes: z.string().trim().optional(),
  })
  .refine((data) => data.endTime > data.startTime, {
    message: 'endTime must be after startTime',
    path: ['endTime'],
  });

// Partial - cross-field end>start validity is checked in the service after
// merging with the existing shift's current values, since either field may
// be absent here.
export const updateShiftSchema = z.object({
  staffId: z.string().uuid('Invalid staff id').optional(),
  startTime: z.coerce.date().optional(),
  endTime: z.coerce.date().optional(),
  notes: z.string().trim().optional(),
});

export const shiftIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  shiftId: z.string().uuid('Invalid shift id'),
});

// Both required deliberately - no unbounded "every shift ever" default.
export const dateRangeQuerySchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((data) => data.to > data.from, {
    message: 'to must be after from',
    path: ['to'],
  });
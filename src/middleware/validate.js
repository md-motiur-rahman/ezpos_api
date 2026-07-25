import { AppError } from '../utils/AppError.js';

/**
 * Generic body validator using a zod schema. On success, req.body is
 * replaced with the parsed (and any zod-transformed) data. On failure,
 * throws a single AppError listing every validation issue - every future
 * module's routes reuse this instead of hand-rolling their own checks.
 *
 * Usage:
 *   router.post('/register', validateBody(registerSchema), controller);
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return next(new AppError(`Invalid request body - ${message}`, 400));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Same idea as validateBody, but for URL params (e.g. validating that :id
 * is actually a UUID before it ever reaches a query - otherwise a malformed
 * ID hits Postgres directly and surfaces as a generic 500 instead of 400).
 *
 * Usage:
 *   router.get('/:id', validateParams(z.object({ id: z.string().uuid() })), controller);
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return next(new AppError(`Invalid request params - ${message}`, 400));
    }
    req.params = result.data;
    next();
  };
}
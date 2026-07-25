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
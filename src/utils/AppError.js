/**
 * Standard error class for expected, "operational" errors - things like
 * bad input, not found, unauthorized, etc. These are safe to show to the
 * client as-is.
 *
 * Any error that is NOT an AppError is treated as an unexpected bug: it
 * gets logged in full, but the client only ever sees a generic message
 * (never internal details or stack traces).
 *
 * Usage in any module:
 *   throw new AppError('Menu item not found', 404);
 *   throw new AppError('Staff PIN incorrect', 401);
 */
export class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
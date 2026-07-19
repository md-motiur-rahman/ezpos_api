import { logger } from '../utils/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * Centralized error handler - the single place that turns any thrown error
 * into an HTTP response. Every module relies on this same response shape:
 *
 *   { "error": { "message": "..." } }
 *
 * Operational errors (AppError - expected: not found, bad input, etc.)
 * are shown to the client as-is, using their own statusCode.
 *
 * Anything else is treated as an unexpected bug: logged in full (message +
 * stack), but the client only ever sees a generic 500 message - never
 * internal details, even in development, to keep this predictable to build
 * against from day one.
 */
export function errorHandler(err, req, res, next) {
  const isOperational = err.isOperational === true;
  const statusCode = isOperational ? err.statusCode : 500;
  const message = isOperational ? err.message : 'Internal server error';

  const logPayload = { err, statusCode, path: req.originalUrl, method: req.method };
  if (isOperational) {
    logger.warn(logPayload, message);
  } else {
    logger.error(logPayload, err.message || 'Unexpected error');
  }

  res.status(statusCode).json({ error: { message } });
}

/**
 * 404 fallback for routes that don't match anything. Built as an AppError
 * and forwarded via next(), so it flows through the same errorHandler
 * above rather than being a separate special case.
 */
export function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}
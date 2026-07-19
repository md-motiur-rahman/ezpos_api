/**
 * Wraps an async Express route handler so any thrown error (or rejected
 * promise) is automatically passed to next(err) - and from there, to our
 * centralized error-handling middleware.
 *
 * Without this, every async route needs its own try/catch, or an error
 * inside it crashes the request silently (Express 4 doesn't catch async
 * errors on its own).
 *
 * Usage:
 *   router.get('/menu/:id', asyncHandler(async (req, res) => {
 *     const item = await getMenuItem(req.params.id);
 *     if (!item) throw new AppError('Menu item not found', 404);
 *     res.json(item);
 *   }));
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
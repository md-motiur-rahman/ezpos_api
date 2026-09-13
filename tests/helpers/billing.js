import { query } from '../../src/db/pool.js';
import { verifyAccessToken } from '../../src/utils/jwt.js';

/**
 * Puts a card "on file" for the company owned by this auth header.
 *
 * createShop refuses to start a subscription without one (Stripe will happily
 * begin a trial uncarded and then fail the renewal 14 days later), so almost
 * every fixture in this suite needs this before it can create its shop.
 *
 * Writes the flag directly rather than going through checkout: the real path
 * is a hosted Stripe Checkout redirect followed by a webhook, neither of which
 * a test can drive. billing-payment-method.test.js covers that path properly
 * by feeding the webhook a real signed checkout.session.completed event; this
 * is only for the many fixtures whose subject is something else entirely and
 * that just need a shop to exist.
 *
 * Resolves the owner from the token rather than calling GET /api/companies/mine:
 * this runs in ~65 fixtures across the suite, and one SQL statement is
 * considerably cheaper than a full trip through the middleware stack.
 */
export async function enablePaymentMethod(authHeader) {
  const { sub } = verifyAccessToken(authHeader.replace(/^Bearer /, ''));
  await query(
    `UPDATE companies SET has_payment_method = true WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [sub]
  );
}

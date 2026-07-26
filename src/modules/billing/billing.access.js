/**
 * Whether a company's billing state should block access to shop operations.
 *
 * Computed on demand rather than stored as a flag: a stored "locked" boolean
 * would need a scheduled job to flip it the moment a grace period expires, and
 * would be wrong in the window before that job ran. Same reasoning as token
 * expiry checks elsewhere in the project.
 *
 * - canceled / unpaid: Stripe has given up collecting. Always locked.
 * - past_due: payment failed but Stripe is still retrying. Locked only once
 *   the grace period has actually run out.
 * - anything else (active, trialing, null): not locked.
 *
 * A past_due company with no grace period recorded is treated as NOT locked -
 * that shouldn't happen (3.6 sets one on every first failure), and erring
 * toward keeping a real restaurant trading is the safer failure mode.
 */
export function isBillingLocked(company) {
  const status = company.subscription_status;

  if (status === 'canceled' || status === 'unpaid') {
    return true;
  }

  if (status !== 'past_due' || !company.grace_period_ends_at) {
    return false;
  }

  return new Date(company.grace_period_ends_at).getTime() < Date.now();
}
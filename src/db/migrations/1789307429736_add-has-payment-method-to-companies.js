export const shorthands = undefined;

/**
 * Stripe does not require a payment method to START a trial subscription, so
 * until now a company could reach the end of its 14-day trial with no card on
 * file: the renewal invoice then fails and the company lands in past_due with
 * no in-app way to fix it. The same gap made REOPENING impossible - closing
 * the last shop clears stripe_subscription_id but deliberately never clears
 * trial_ends_at (no second free trial), so the next shop creates a
 * subscription with trialDays: null, which Stripe refuses outright with
 * "This customer has no attached payment source or default payment method."
 *
 * This flag is a local mirror of "the Stripe customer has a default payment
 * method", set by the checkout.session.completed webhook. It exists so shop
 * creation can check it without a live Stripe API round-trip on every call.
 *
 * DEFAULT false is deliberate and is the honest state: no company has ever
 * had a card collected, because no card-collection code existed anywhere in
 * this app before now. Every existing company must genuinely go through
 * checkout before its next subscription, so backfilling true would be a lie
 * that reintroduces exactly the failure this fixes.
 */
export const up = (pgm) => {
  pgm.addColumn('companies', {
    has_payment_method: { type: 'boolean', notNull: true, default: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'has_payment_method');
};

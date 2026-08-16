import crypto from 'node:crypto';

/**
 * Module 9.5 - the PaymentProvider abstraction.
 *
 * This is the seam Module 13 ("Real Payment Provider Integration (later,
 * once vendor decided)") plugs into. No vendor has been selected yet, so
 * there is no SDK to call and nothing here touches the network in ANY
 * environment - deliberately unlike utils/stripe.js, which fakes only under
 * config.env.isTest because it DOES have a real backend the rest of the
 * time. Once a vendor exists, 13.1 replaces these functions' bodies with
 * real SDK calls and every caller keeps working unchanged, because callers
 * only ever depend on the { success, providerReference, failureReason }
 * shape below - never on how it was produced.
 *
 * Deliberately NOT modelled here (out of scope, and each would be a guess
 * at a vendor whose API nobody has seen yet):
 *   - card tokenization / PAN handling - the till app talks to the terminal,
 *     this API never sees card data
 *   - 3DS / SCA challenge flows
 */

/**
 * Charges a card for `amount` against `orderId`.
 *
 * Returns { success: true, providerReference } on success, or
 * { success: false, failureReason } on a declined/failed charge. It does NOT
 * throw on a decline - a declined card is an ordinary business outcome the
 * till must show the cashier, not an exceptional condition. (A future real
 * implementation should still throw/AppError on a genuine transport failure,
 * which is a different thing from a decline.)
 *
 * Today this always succeeds: with no vendor wired up there is nothing that
 * could decline, and inventing a synthetic failure mode would make the till
 * unusable for no reason. The caller still handles { success: false }
 * properly (402, no payment row written) - verified by temporarily forcing
 * this to return a failure and confirming that path behaves correctly, the
 * same way 9.1 proved its min/max enforcement wasn't vacuous. That branch
 * becomes genuinely reachable in 13.1 without the caller changing.
 */
export async function chargeCard({ amount, orderId }) {
  return {
    success: true,
    providerReference: `placeholder_${crypto.randomUUID()}`,
  };
}

/**
 * Module 9.6 - refunds a previously-charged card.
 *
 * A SEPARATE function extending this same interface rather than an extra
 * mode on chargeCard - exactly as 9.5's own comment here anticipated
 * ("9.6 owns refunds; it will extend this same interface with its own
 * function rather than overloading this one"). Every real card provider
 * models a refund as its own operation against the original transaction,
 * not as a negative charge, so this signature takes the ORIGINAL charge's
 * `providerReference` as the thing being reversed.
 *
 * Returns the identical { success, providerReference, failureReason } shape
 * as chargeCard, and likewise does NOT throw on a provider-side rejection -
 * a refused refund is a business outcome the till must show the cashier.
 * The `providerReference` returned here is the REFUND's own reference, a
 * distinct value from the charge reference passed in, which is why the
 * caller stores it in order_refunds.provider_reference rather than reusing
 * the payment's.
 *
 * Today this always succeeds, for the same reason chargeCard does. The
 * caller's failure path (402, no refund row written, order status
 * untouched) was proven non-vacuous by temporarily forcing this to return
 * { success: false } and confirming that behaviour, then reverting.
 */
export async function refundCard({ amount, providerReference, orderId }) {
  return {
    success: true,
    providerReference: `placeholder_refund_${crypto.randomUUID()}`,
  };
}

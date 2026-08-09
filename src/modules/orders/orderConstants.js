/**
 * Small, fixed, rarely-changing sets - JS code constants validated at the
 * app layer, not a DB enum type or lookup table, same precedent as 6.5's
 * ALLERGENS, 7.7's WASTAGE_REASONS, 8.2's SCAN_STATES.
 */

export const ORDER_TYPES = Object.freeze(['dine_in', 'takeaway']);

/**
 * Started deliberately minimal in 9.1 (only 'open'), extended by each
 * submodule as it was actually designed rather than guessed at up front:
 *   - 'cancelled'      (9.4) - the value 9.1/9.2/9.3 wrote their
 *                       status === 'open' guards in anticipation of,
 *                       without knowing what it would be called yet.
 *   - 'partially_paid' (9.5) - set on the FIRST payment when it doesn't
 *                       cover the full balance. Confirmed directly: this
 *                       LOCKS the order (no more items/discounts/voids),
 *                       because 9.2/9.3/9.4's existing `=== 'open'` checks
 *                       stop matching the moment it's set - no code in
 *                       those submodules had to change for that to work.
 *   - 'paid'           (9.5) - terminal, once payments cover the total.
 */
export const ORDER_STATUSES = Object.freeze(['open', 'cancelled', 'partially_paid', 'paid']);

/** 9.3 - percentage is 0-100 of the amount it's applied against; fixed is a currency amount. */
export const DISCOUNT_TYPES = Object.freeze(['percentage', 'fixed']);

/**
 * 9.5. 'card' goes through paymentProvider.js (an abstraction over a vendor
 * not yet chosen - Module 13); 'cash' has no provider involvement at all.
 */
export const PAYMENT_METHODS = Object.freeze(['cash', 'card']);

/** The statuses a payment may still be taken against (9.5) - a cancelled or fully-paid order accepts none. */
export const PAYABLE_ORDER_STATUSES = Object.freeze(['open', 'partially_paid']);

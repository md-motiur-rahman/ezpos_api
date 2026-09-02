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
 *   - 'paid'           (9.5) - once payments cover the total.
 *   - 'partially_refunded' / 'refunded' (9.6) - see below.
 *
 * The `orders.status` column is plain `text` with no CHECK constraint (see
 * its 9.1 migration), so adding values here needs no schema change - the
 * same way 9.4 and 9.5 added theirs.
 */
export const ORDER_STATUSES = Object.freeze([
  'open',
  'cancelled',
  'partially_paid',
  'paid',
  // 9.6. Set after any refund, recomputed across EVERY payment on the
  // order: 'refunded' once net paid (gross payments minus all refunds)
  // reaches zero, 'partially_refunded' while some net payment remains.
  // These deliberately REPLACE 'paid'/'partially_paid' rather than sitting
  // alongside them - a refund is one-directional (this project's "no
  // reversal mechanism" philosophy), so once an order enters the refund
  // track it stays there.
  'partially_refunded',
  'refunded',
]);

/** 9.3 - percentage is 0-100 of the amount it's applied against; fixed is a currency amount. */
export const DISCOUNT_TYPES = Object.freeze(['percentage', 'fixed']);

/**
 * 9.5. 'card' goes through paymentProvider.js (an abstraction over a vendor
 * not yet chosen - Module 13); 'cash' has no provider involvement at all.
 */
export const PAYMENT_METHODS = Object.freeze(['cash', 'card']);

/** The statuses a payment may still be taken against (9.5) - a cancelled or fully-paid order accepts none. */
export const PAYABLE_ORDER_STATUSES = Object.freeze(['open', 'partially_paid']);

/**
 * The statuses a refund may be issued against (9.6).
 *
 * 'open' and 'cancelled' are absent because neither can have a payment to
 * refund in the first place: the first payment moves an order out of
 * 'open', and 9.4's cancelOrder only accepts an order that is still 'open'
 * (so a cancelled order never had one).
 *
 * 'refunded' is absent because every payment is already fully refunded -
 * the per-payment refundable-balance check would reject it anyway, but
 * failing at the status level gives the till a clearer message.
 *
 * DELIBERATE CONSEQUENCE, flagged rather than hidden: 'partially_refunded'
 * and 'refunded' are NOT in PAYABLE_ORDER_STATUSES above, so once any
 * refund is issued the order accepts no further payment. That follows the
 * same one-directional philosophy as cancel/void/receipts. It does mean an
 * order that was only partially paid and then refunded cannot be topped up
 * again - settle such a case as a new order.
 */
export const REFUNDABLE_ORDER_STATUSES = Object.freeze([
  'partially_paid',
  'paid',
  'partially_refunded',
]);

/**
 * 10.2 - one order_item's kitchen prep status. 'pending' is the default on
 * creation (confirmed directly, added beyond the roadmap's literal
 * "in progress -> ready -> served" wording - something has to be true
 * before the kitchen has started an item). Transitions are UNRESTRICTED:
 * any value here may be set at any time, forward or backward - unlike
 * ORDER_STATUSES above, which only ever advances through one-directional
 * business events (cancel/pay/refund), a prep status is a live operational
 * field the kitchen routinely needs to correct in the moment, with no
 * audit/compliance reason to lock it into one direction.
 *
 * `order_items.status` is plain `text` with no CHECK constraint (see its
 * 10.2 migration), so adding a value here needs no schema change - the same
 * convention as ORDER_TYPES/DISCOUNT_TYPES/PAYMENT_METHODS above.
 */
export const ORDER_ITEM_STATUSES = Object.freeze(['pending', 'in_progress', 'ready', 'served']);

/**
 * 10.3 - the item statuses that TRIGGER an inventory deduction (7.9's
 * engine). Reaching any of these means the kitchen has actually made the
 * item, so the ingredients have physically been consumed.
 *
 * 'ready' is the trigger point (confirmed directly): the moment the kitchen
 * declares the item made. 'served' is included as a BACKSTOP, not as a
 * second trigger - 10.2 deliberately allows unrestricted transitions and has
 * its own test for a direct 'pending' -> 'served' jump, so a real sale could
 * otherwise skip straight past 'ready' and never deduct anything, which
 * would be a silent under-deduction in a flow 10.2 explicitly supports.
 * Anything at or past "the kitchen made this" deducts.
 *
 * Listing two statuses here is safe ONLY because the deduction is claimed
 * atomically via order_items.inventory_deducted_at (see its 10.3 migration):
 * an item that passes through 'ready' and then 'served' deducts exactly
 * once, as does one that jumps straight to 'served', as does one that is
 * corrected back to 'in_progress' and set to 'ready' again. The status may
 * be re-entered any number of times; stock moves once, ever.
 *
 * 'pending'/'in_progress' deliberately do NOT deduct - prep can be abandoned
 * or the line voided mid-cook, and there is no reversal mechanism (this
 * project's consistent philosophy, see 8.4/9.4).
 */
export const INVENTORY_DEDUCTION_STATUSES = Object.freeze(['ready', 'served']);

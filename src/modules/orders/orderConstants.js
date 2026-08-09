/**
 * Small, fixed, rarely-changing sets - JS code constants validated at the
 * app layer, not a DB enum type or lookup table, same precedent as 6.5's
 * ALLERGENS, 7.7's WASTAGE_REASONS, 8.2's SCAN_STATES.
 */

export const ORDER_TYPES = Object.freeze(['dine_in', 'takeaway']);

/**
 * Deliberately minimal (confirmed directly) - only 'open' is reachable
 * today. 9.4 (cancellation) and 9.5 (payment) will add their own values to
 * this array when those submodules are actually designed, rather than 9.1
 * guessing at states they haven't been scoped yet to need.
 */
// 'cancelled' added in 9.4 - the value 9.1/9.2/9.3 wrote their status === 'open'
// guards in anticipation of, without knowing what it would be called yet.
export const ORDER_STATUSES = Object.freeze(['open', 'cancelled']);

/** 9.3 - percentage is 0-100 of the amount it's applied against; fixed is a currency amount. */
export const DISCOUNT_TYPES = Object.freeze(['percentage', 'fixed']);

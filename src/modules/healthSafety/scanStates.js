/**
 * Which of 8.1's two shelf-life durations applies to a scan - a sealed item
 * uses shelf_life_days, an opened/prepped one uses shelf_life_opened_days.
 * Small, fixed set validated at the app layer, not a DB enum type - same
 * precedent as 6.5's ALLERGENS and 7.7's WASTAGE_REASONS.
 */
export const SCAN_STATES = Object.freeze(['sealed', 'opened']);

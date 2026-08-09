/**
 * A small, fixed, rarely-changing set of wastage reasons - a code constant
 * here, not a database table or Postgres enum type, same precedent as
 * 6.5's ALLERGENS.
 */
export const WASTAGE_REASONS = Object.freeze(['spoiled', 'damaged', 'expired', 'prep_error', 'other']);
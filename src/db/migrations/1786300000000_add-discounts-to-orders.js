export const shorthands = undefined;

const DISCOUNT_COLUMNS = {
  // Validated at the app layer against DISCOUNT_TYPES ('percentage'|'fixed') -
  // same code-constant convention as type/status on this same table, not a
  // DB enum. NULL = no discount applied, never confused with a 0 value.
  discount_type: { type: 'text' },
  discount_value: { type: 'numeric(10,2)' },
  // Optional freeform note, same "optional notes alongside a fixed reason
  // set" shape as 7.7's wastage notes, but the type itself already carries
  // the "reason" (percentage vs fixed) here so this is purely optional.
  discount_reason: { type: 'text' },
  // Same actor-audit shape as created_by_actor_type/_id - who applied this
  // discount, for accountability (12.x reporting will want this).
  discounted_by_actor_type: { type: 'text' },
  discounted_by_actor_id: { type: 'uuid' },
  discounted_at: { type: 'timestamptz' },
};

export const up = (pgm) => {
  // Order-level discount, applied to the subtotal after any per-line
  // discounts below. Same "explicit null clears, omitted leaves untouched"
  // PATCH contract as 7.3's low_stock_threshold / 8.1's shelf-life columns.
  pgm.addColumn('orders', DISCOUNT_COLUMNS);

  // Per-line discount (9.3, confirmed directly to support both levels) -
  // same six columns, same contract, one line's own markdown independent
  // of any order-level discount applied on top.
  pgm.addColumn('order_items', DISCOUNT_COLUMNS);
};

export const down = (pgm) => {
  const columns = Object.keys(DISCOUNT_COLUMNS);
  pgm.dropColumns('orders', columns);
  pgm.dropColumns('order_items', columns);
};

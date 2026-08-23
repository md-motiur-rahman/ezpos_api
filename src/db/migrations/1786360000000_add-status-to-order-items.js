export const shorthands = undefined;

export const up = (pgm) => {
  // 10.2 - item status flow. NOT NULL DEFAULT 'pending': every pre-existing
  // order_item and every item created through 9.1/9.2/9.7 backfills to
  // 'pending' automatically, so nothing downstream (9.3's discount checks,
  // 9.4's void guard, the response shape) needs to special-case a missing
  // value the way 9.8's vat_rate had to for a NULLABLE column - here there is
  // no "never computed" case to represent, since a status is meaningful for
  // every item from the moment it exists.
  //
  // 'pending' (confirmed directly, added beyond the roadmap's literal
  // 3-state list) sits BEFORE 'in_progress': the roadmap names
  // "in progress -> ready -> served" but doesn't name a starting state, and
  // something has to be true before the kitchen has started an item. Kept
  // as a plain `text` with no CHECK constraint - same convention as
  // orders.status (its own 9.1 migration) and every other small fixed set
  // in this project (ORDER_TYPES, DISCOUNT_TYPES, PAYMENT_METHODS):
  // validated in code (ORDER_ITEM_STATUSES), not the database.
  //
  // Transitions are deliberately UNRESTRICTED (confirmed directly): any
  // status may be set at any time, forward or backward. Unlike
  // orders.status (which only ever advances through 9.4/9.5/9.6's
  // one-directional business events - cancel, pay, refund), an item's prep
  // status is a live operational field a kitchen routinely needs to correct
  // in the moment (a mis-tap), with no audit/compliance reason to lock it
  // into one direction the way money movements are.
  pgm.addColumns('order_items', {
    status: { type: 'text', notNull: true, default: 'pending' },
    // Same actor-tracking shape as every other mutation in this project
    // (discounted_by_*, cancelled_by_*, voided_by_*, paid_by_*,
    // refunded_by_*) - nullable because a freshly-created item's status has
    // never been explicitly SET by anyone, it only got 'pending' from the
    // column default above.
    status_updated_at: { type: 'timestamptz' },
    status_updated_by_actor_type: { type: 'text' },
    status_updated_by_actor_id: { type: 'uuid' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('order_items', [
    'status',
    'status_updated_at',
    'status_updated_by_actor_type',
    'status_updated_by_actor_id',
  ]);
};

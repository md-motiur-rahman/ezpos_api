export const shorthands = undefined;

export const up = (pgm) => {
  // Order-level cancellation (9.4). status gains a new 'cancelled' value
  // (JS-constant ORDER_STATUSES, not a DB enum - same convention as
  // type/status elsewhere on this table). was_prepped is REQUIRED input on
  // the cancel action itself (staff declares it explicitly, confirmed
  // directly - no KDS exists yet to detect prep state automatically), but
  // nullable here since it's meaningless before an order is ever cancelled.
  pgm.addColumn('orders', {
    cancelled_at: { type: 'timestamptz' },
    cancelled_by_actor_type: { type: 'text' },
    cancelled_by_actor_id: { type: 'uuid' },
    cancellation_reason: { type: 'text' },
    was_prepped: { type: 'boolean' },
  });

  // Per-line void (9.4, confirmed directly alongside order-level
  // cancellation) - same shape as above, one line's own removal
  // independent of the rest of the order. Soft-delete-style: the row is
  // kept (audit trail), never actually removed.
  pgm.addColumn('order_items', {
    voided_at: { type: 'timestamptz' },
    voided_by_actor_type: { type: 'text' },
    voided_by_actor_id: { type: 'uuid' },
    void_reason: { type: 'text' },
    was_prepped: { type: 'boolean' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('orders', [
    'cancelled_at',
    'cancelled_by_actor_type',
    'cancelled_by_actor_id',
    'cancellation_reason',
    'was_prepped',
  ]);
  pgm.dropColumns('order_items', [
    'voided_at',
    'voided_by_actor_type',
    'voided_by_actor_id',
    'void_reason',
    'was_prepped',
  ]);
};

export const shorthands = undefined;

export const up = (pgm) => {
  // Immutable log of every refund issued against a PAYMENT (9.6) - same
  // "already-applied state change" pattern as 7.6's receipts, 7.7's wastage
  // logs, 8.2's scans and 9.5's payments: no PATCH, no DELETE, no
  // deleted_at. This table is exactly what 9.5's own migration comment
  // anticipated ("correcting a payment is 9.6's job, via a new record, not
  // by mutating this one") - order_payments stays untouched and immutable.
  //
  // Partial refunds are simply MULTIPLE rows against one payment, same
  // "multiple receipts per PO" / "multiple payments per order" precedent
  // rather than a single row that gets topped up.
  pgm.createTable('order_refunds', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // References the PAYMENT, not the order - confirmed directly. A refund
    // has to know which payment funded it: a card refund must reverse
    // against that specific charge's provider_reference, which an
    // order-level pool could not identify on a split cash+card order. The
    // owning order is reached through the payment, same as
    // order_item_modifiers reaching its order only via order_items rather
    // than carrying a redundant order_id of its own.
    payment_id: { type: 'uuid', notNull: true, references: 'order_payments' },
    // Capped at the parent payment's own remaining refundable balance
    // (payment.amount minus its existing refunds), enforced at the app
    // layer at issue time - so the sum of these can never exceed the
    // payment they belong to, and net paid across an order can never go
    // negative.
    amount: { type: 'numeric(10,2)', notNull: true },
    reason: { type: 'text' },
    // Card only (NULL for cash): the reference for the REFUND itself,
    // returned by the provider - a distinct value from the original
    // charge's order_payments.provider_reference, not a copy of it. Today
    // that's paymentProvider.refundCard's placeholder, since no vendor is
    // chosen yet (Module 13); the column shape doesn't change when a real
    // SDK lands behind that same interface.
    provider_reference: { type: 'text' },
    // Who issued the refund - same req.actor pattern as created_by_actor_*,
    // paid_by_actor_* and the 9.3/9.4 audit columns.
    refunded_by_actor_type: { type: 'text', notNull: true },
    refunded_by_actor_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Deliberately NO `method` column - it's always the parent payment's
  // method, so storing it here would be a redundant copy that could drift.
  // "Derive, don't store" (CLAUDE.md section 2).

  pgm.createIndex('order_refunds', 'payment_id');
};

export const down = (pgm) => {
  pgm.dropTable('order_refunds');
};

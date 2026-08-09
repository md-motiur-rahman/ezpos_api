export const shorthands = undefined;

export const up = (pgm) => {
  // Immutable log of every payment taken against an order (9.5) - same
  // "already-applied state change" pattern as 7.6's receipts, 7.7's wastage
  // logs and 8.2's scans: no PATCH, no DELETE, no deleted_at. Correcting a
  // payment is 9.6's (refunds) job, via a new record, not by mutating this
  // one. Split/partial payment is simply MULTIPLE rows against one order -
  // same "multiple receipts per PO" precedent as 7.6, rather than a single
  // row that gets topped up.
  pgm.createTable('order_payments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    order_id: { type: 'uuid', notNull: true, references: 'orders' },
    // Validated at the app layer against PAYMENT_METHODS ('cash'|'card') -
    // same code-constant convention as ORDER_TYPES/ORDER_STATUSES, not a DB
    // enum type.
    method: { type: 'text', notNull: true },
    // What was actually CREDITED toward the order's balance. For cash this
    // is min(amount_tendered, balance owed) - never more than is owed, so
    // the sum of these across an order can never exceed its total.
    amount: { type: 'numeric(10,2)', notNull: true },
    // Cash only (NULL for card): what the customer physically handed over,
    // which may EXCEED `amount` when they over-tender. Change due is
    // derived at response time (amount_tendered - amount), never stored -
    // "derive, don't store", same as lineTotal/subtotal/discountAmount.
    amount_tendered: { type: 'numeric(10,2)' },
    // Card only (NULL for cash): the reference returned by the payment
    // provider. Today that's paymentProvider.js's placeholder, since no
    // vendor is chosen yet (Module 13); the column shape doesn't change
    // when a real SDK lands behind that same interface.
    provider_reference: { type: 'text' },
    // Who took the payment - same req.actor pattern as created_by_actor_*
    // and the 9.3/9.4 audit columns.
    paid_by_actor_type: { type: 'text', notNull: true },
    paid_by_actor_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('order_payments', 'order_id');
};

export const down = (pgm) => {
  pgm.dropTable('order_payments');
};

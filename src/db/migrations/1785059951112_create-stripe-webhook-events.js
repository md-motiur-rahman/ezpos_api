export const shorthands = undefined;

export const up = (pgm) => {
  // Mirrors Stripe's own subscription.status values (trialing/active/past_due/
  // canceled/...). Stored as-is rather than app-validated: it's Stripe's data,
  // not user input, and Stripe may add values we don't know about yet.
  pgm.addColumn('companies', {
    subscription_status: { type: 'text' },
  });

  pgm.createTable('stripe_webhook_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // The dedup key. Stripe retries deliveries, so the unique constraint here
    // IS the idempotency mechanism.
    stripe_event_id: { type: 'text', notNull: true, unique: true },
    event_type: { type: 'text', notNull: true },
    // Nullable: an event might not map to a company we know about.
    company_id: { type: 'uuid', references: 'companies' },
    // Minor units (pence). Invoice events only.
    amount: { type: 'integer' },
    // 'succeeded' | 'failed'. Invoice events only.
    status: { type: 'text' },
    // Stripe's own timestamp for when the event happened.
    occurred_at: { type: 'timestamptz' },
    // When we processed it.
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Module 3.7 (billing history) will query by company, newest first.
  pgm.createIndex('stripe_webhook_events', ['company_id', 'occurred_at']);
};

export const down = (pgm) => {
  pgm.dropTable('stripe_webhook_events');
  pgm.dropColumn('companies', 'subscription_status');
};
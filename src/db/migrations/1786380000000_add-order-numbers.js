export const shorthands = undefined;

export const up = (pgm) => {
  // Human-readable per-shop order numbers, resetting daily (confirmed
  // directly). Until now an order's only identifier was its UUID, which is
  // unusable on a kitchen display or when calling an order out to a
  // customer.
  //
  // A COUNTER TABLE rather than a Postgres sequence, deliberately:
  //   - A sequence cannot be reset per shop per day without DDL, and would
  //     need one sequence per shop.
  //   - Sequences are non-transactional by design, so a rolled-back insert
  //     burns a number and leaves visible gaps in what staff read as a
  //     contiguous daily count.
  // One row per (shop, day) instead, incremented atomically.
  pgm.createTable('shop_order_counters', {
    shop_id: { type: 'uuid', notNull: true, references: 'shops', onDelete: 'CASCADE' },
    // A `date`, not a timestamptz - this is a calendar day, not an instant.
    // NOTE the 8.2 trap: `pg` parses a date column as a JS Date at LOCAL
    // midnight, so anything reading this back out must format it with local
    // getters, never .toISOString(). The app only ever passes this value IN
    // as a 'YYYY-MM-DD' string, which sidesteps the issue entirely.
    business_date: { type: 'date', notNull: true },
    last_number: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // The composite primary key IS the concurrency mechanism, not just a
  // uniqueness constraint. Allocation is a single
  //   INSERT ... ON CONFLICT (shop_id, business_date) DO UPDATE
  //   SET last_number = last_number + 1 RETURNING last_number
  // which Postgres serializes on this key, so two tills ringing up at the
  // same instant provably receive different numbers. A SELECT MAX()+1 would
  // hand them both the same one - this project has no transaction wrapper
  // anywhere (CLAUDE.md section 2) to make read-then-write safe, so the
  // atomicity has to live in one statement. Verified empirically under real
  // concurrency before any code was written against it, same discipline as
  // 10.3's deduction claim and 9.7's ON CONFLICT finding.
  pgm.addConstraint('shop_order_counters', 'shop_order_counters_pkey', {
    primaryKey: ['shop_id', 'business_date'],
  });

  // Both NULLABLE, and that is the regression strategy - identical reasoning
  // to 9.7's client_order_id, 9.8's vat_rate and 10.3's
  // inventory_deducted_at: every order created before this migration reads
  // back null rather than a fabricated number, so nothing already shipped
  // changes by construction rather than by remembering to re-test it.
  pgm.addColumns('orders', {
    order_number: { type: 'integer' },
    // The day the number was drawn from, needed to make the number unique
    // (a #1 exists for every shop on every trading day) and to render it
    // correctly after midnight.
    order_date: { type: 'date' },
  });

  // Defence in depth behind the counter. PARTIAL, because every pre-existing
  // order has NULL for both columns and would otherwise collide with every
  // other pre-existing order.
  //
  // WARNING for any future code: this being partial means an ON CONFLICT
  // clause targeting it MUST restate the `WHERE order_number IS NOT NULL`
  // predicate, or Postgres raises 42P10 rather than falling back to a plain
  // unique check - the lesson verified empirically in 9.7. Nothing does that
  // today (allocation happens on shop_order_counters, not here), but the
  // hazard belongs next to the index.
  pgm.createIndex('orders', ['shop_id', 'order_date', 'order_number'], {
    unique: true,
    where: 'order_number IS NOT NULL',
    name: 'orders_shop_date_number_unique',
  });
};

export const down = (pgm) => {
  pgm.dropIndex('orders', ['shop_id', 'order_date', 'order_number'], {
    name: 'orders_shop_date_number_unique',
  });
  pgm.dropColumns('orders', ['order_number', 'order_date']);
  pgm.dropTable('shop_order_counters');
};

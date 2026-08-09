export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop, matching purchase_orders' own scope. Deliberately NO
  // deleted_at - immutable once created, same reasoning as 7.6's receipts:
  // this represents an already-applied stock DECREMENT. Correcting a
  // mistaken entry goes through 7.1's existing manual quantityOnHand
  // correction, not a reversal mechanism here.
  pgm.createTable('wastage_logs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    wasted_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('wastage_log_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    wastage_log_id: { type: 'uuid', notNull: true, references: 'wastage_logs' },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    quantity_wasted: { type: 'numeric(10,3)', notNull: true },
    // Validated at the app layer against the fixed WASTAGE_REASONS list -
    // same code-constant precedent as 6.5's ALLERGENS, not a DB enum type
    // or lookup table, for the same reason: small, fixed, rarely-changing.
    reason: { type: 'text', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('wastage_logs', 'shop_id');
  pgm.createIndex('wastage_log_items', 'wastage_log_id');
  pgm.createIndex('wastage_log_items', 'inventory_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('wastage_log_items');
  pgm.dropTable('wastage_logs');
};
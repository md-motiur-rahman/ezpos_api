export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop, matching suppliers/inventory_items' own scope. Logging only -
  // no status/workflow field (draft/submitted/approved/received) and no
  // automatic effect on inventory_items.quantity_on_hand - confirmed scope
  // directly, deliberately excluded to avoid silently wiring this into the
  // same territory as the flagged-for-scrutiny deduction engine (7.9).
  pgm.createTable('purchase_orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    supplier_id: { type: 'uuid', notNull: true, references: 'suppliers' },
    // Defaults to now(), but overridable - logging a past order that
    // already happened is a real use case for a log, not just "orders
    // placed through this system".
    ordered_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // Line items - no independent deleted_at, reachable only through their
  // parent PO's deleted_at filter, same reasoning as 6.4's join tables.
  pgm.createTable('purchase_order_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    purchase_order_id: { type: 'uuid', notNull: true, references: 'purchase_orders' },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    quantity: { type: 'numeric(10,3)', notNull: true },
    // Nullable - cost may not be known yet at logging time (e.g. invoice
    // not yet received).
    unit_cost: { type: 'numeric(10,2)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('purchase_orders', 'shop_id');
  pgm.createIndex('purchase_orders', 'supplier_id');
  pgm.createIndex('purchase_order_items', 'purchase_order_id');
  pgm.createIndex('purchase_order_items', 'inventory_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('purchase_order_items');
  pgm.dropTable('purchase_orders');
};
export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop from the start, unlike Module 6's master/local split - stock is
  // physical, sitting at one location, not shared company-level data.
  pgm.createTable('inventory_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    name: { type: 'text', notNull: true },
    // Free text ("kg", "L", "each", "case") rather than a fixed list like
    // 6.5's allergens - units are too business-specific to enumerate.
    unit: { type: 'text', notNull: true },
    quantity_on_hand: { type: 'numeric(10,2)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createIndex('inventory_items', 'shop_id');
};

export const down = (pgm) => {
  pgm.dropTable('inventory_items');
};
export const shorthands = undefined;

export const up = (pgm) => {
  // Master-level size variants (6.3) - e.g. "Small"/"Medium"/"Large", each
  // with its own absolute price (not a delta from the base item).
  pgm.createTable('menu_item_variants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    menu_item_id: { type: 'uuid', notNull: true, references: 'menu_items' },
    name: { type: 'text', notNull: true },
    price: { type: 'numeric(10,2)', notNull: true },
    display_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // Shop-level override of a variant - confirmed in scope directly: a shop's
  // price-override/enable-disable power reaches down to variants, not just
  // base items. Exact same shape and reasoning as shop_menu_item_overrides
  // (6.2): NOT soft-deleted, pure current-state config.
  pgm.createTable('shop_menu_variant_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    variant_id: { type: 'uuid', notNull: true, references: 'menu_item_variants' },
    is_enabled: { type: 'boolean', notNull: true, default: true },
    price_override: { type: 'numeric(10,2)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('shop_menu_variant_overrides', 'shop_menu_variant_overrides_unique', {
    unique: ['shop_id', 'variant_id'],
  });

  pgm.createIndex('menu_item_variants', 'menu_item_id');
  pgm.createIndex('shop_menu_variant_overrides', 'shop_id');
};

export const down = (pgm) => {
  pgm.dropTable('shop_menu_variant_overrides');
  pgm.dropTable('menu_item_variants');
};
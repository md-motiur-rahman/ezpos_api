export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop tweak to a MASTER item (6.1) - e.g. KFC Whitechapel disabling
  // nuggets, or pricing them differently locally.
  pgm.createTable('shop_menu_item_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    menu_item_id: { type: 'uuid', notNull: true, references: 'menu_items' },
    is_enabled: { type: 'boolean', notNull: true, default: true },
    // Null means "use the master item's own price" - not every override
    // needs a custom price, most will only touch is_enabled.
    price_override: { type: 'numeric(10,2)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // No deleted_at - this is pure current-state config, not a business
    // record with historical value. "No row" already means "using master
    // defaults" - there's nothing meaningful to preserve by soft-deleting a
    // cleared override. Same reasoning as refresh_tokens/verification_tokens.
  });

  pgm.addConstraint('shop_menu_item_overrides', 'shop_menu_item_overrides_unique', {
    unique: ['shop_id', 'menu_item_id'],
  });

  // A shop's OWN local item (e.g. KFC West London's chicken wrap) - not
  // present on the master menu at all. Genuinely separate table from
  // menu_items rather than a nullable shop_id column on it - avoids
  // touching 6.1's already-tested company-level item behavior.
  pgm.createTable('shop_menu_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    // Still one of the company's real categories - a local item still needs
    // to show up under "Mains" like everything else.
    category_id: { type: 'uuid', notNull: true, references: 'menu_categories' },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    price: { type: 'numeric(10,2)', notNull: true },
    display_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createIndex('shop_menu_item_overrides', 'shop_id');
  pgm.createIndex('shop_menu_items', 'shop_id');
  pgm.createIndex('shop_menu_items', 'category_id');
};

export const down = (pgm) => {
  pgm.dropTable('shop_menu_items');
  pgm.dropTable('shop_menu_item_overrides');
};
export const shorthands = undefined;

export const up = (pgm) => {
  // Master, company-level, reusable across items - e.g. "Choose your sauce".
  pgm.createTable('modifier_groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_id: { type: 'uuid', notNull: true, references: 'companies' },
    name: { type: 'text', notNull: true },
    // min_selections=0 => optional; min=max=1 => "must replace one" (e.g. a
    // sauce swap), matching the confirmed use case directly.
    min_selections: { type: 'integer', notNull: true, default: 0 },
    max_selections: { type: 'integer', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createTable('modifier_options', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    modifier_group_id: { type: 'uuid', notNull: true, references: 'modifier_groups' },
    name: { type: 'text', notNull: true },
    // A DELTA, not an absolute price - legitimately negative (a discount),
    // zero (a free swap), or positive (a premium add-on). Unlike item/variant
    // prices, this is never constrained to be positive.
    price_delta: { type: 'numeric(10,2)', notNull: true, default: 0 },
    display_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // Which groups apply to which MASTER items. Pure current-state
  // relationship - no deleted_at, hard DELETE to detach, same reasoning as
  // the (non-soft-deleted) override tables.
  pgm.createTable('menu_item_modifier_groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    menu_item_id: { type: 'uuid', notNull: true, references: 'menu_items' },
    modifier_group_id: { type: 'uuid', notNull: true, references: 'modifier_groups' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('menu_item_modifier_groups', 'menu_item_modifier_groups_unique', {
    unique: ['menu_item_id', 'modifier_group_id'],
  });

  // Same relationship, one level down for shop-exclusive LOCAL items (6.2).
  // A separate table rather than a polymorphic/nullable FK on the table
  // above - same reasoning as shop_menu_items being separate from
  // menu_items: keeps referential integrity real instead of conditional.
  pgm.createTable('shop_menu_item_modifier_groups', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_menu_item_id: { type: 'uuid', notNull: true, references: 'shop_menu_items' },
    modifier_group_id: { type: 'uuid', notNull: true, references: 'modifier_groups' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('shop_menu_item_modifier_groups', 'shop_menu_item_modifier_groups_unique', {
    unique: ['shop_menu_item_id', 'modifier_group_id'],
  });

  // Shop-level override of a single OPTION (not the whole group) - confirmed
  // scope directly. Exact same shape/reasoning as shop_menu_item_overrides
  // and shop_menu_variant_overrides: NOT soft-deleted, pure current-state.
  pgm.createTable('shop_menu_modifier_option_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    modifier_option_id: { type: 'uuid', notNull: true, references: 'modifier_options' },
    is_enabled: { type: 'boolean', notNull: true, default: true },
    price_delta_override: { type: 'numeric(10,2)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'shop_menu_modifier_option_overrides',
    'shop_menu_modifier_option_overrides_unique',
    { unique: ['shop_id', 'modifier_option_id'] }
  );

  pgm.createIndex('modifier_groups', 'company_id');
  pgm.createIndex('modifier_options', 'modifier_group_id');
  pgm.createIndex('menu_item_modifier_groups', 'menu_item_id');
  pgm.createIndex('shop_menu_item_modifier_groups', 'shop_menu_item_id');
  pgm.createIndex('shop_menu_modifier_option_overrides', 'shop_id');
};

export const down = (pgm) => {
  pgm.dropTable('shop_menu_modifier_option_overrides');
  pgm.dropTable('shop_menu_item_modifier_groups');
  pgm.dropTable('menu_item_modifier_groups');
  pgm.dropTable('modifier_options');
  pgm.dropTable('modifier_groups');
};
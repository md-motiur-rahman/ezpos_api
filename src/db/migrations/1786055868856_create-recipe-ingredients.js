export const shorthands = undefined;

export const up = (pgm) => {
  // 6.5's ingredients were allergen-only (presence/absence). A recipe needs
  // to know HOW MUCH, so a unit becomes required. Backfilled with a
  // reasonable default for any pre-existing (allergen-only) rows.
  pgm.addColumn('ingredients', {
    unit: { type: 'text', notNull: true, default: 'each' },
  });

  // 6.5's item/local-item ingredient links were pure presence/absence (no
  // deleted_at, no updated_at - "attached or not" was the whole story).
  // Adding a mutable quantity means these are no longer purely static
  // relationships, so updated_at is added alongside it.
  pgm.addColumn('menu_item_ingredients', {
    quantity: { type: 'numeric(10,3)', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addColumn('shop_menu_item_ingredients', {
    quantity: { type: 'numeric(10,3)', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Variant recipes - variants are master-item-only (6.3's established
  // precedent), so there's no local-item equivalent of this table.
  pgm.createTable('menu_item_variant_ingredients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    variant_id: { type: 'uuid', notNull: true, references: 'menu_item_variants' },
    ingredient_id: { type: 'uuid', notNull: true, references: 'ingredients' },
    // numeric(10,3), not (10,2) like money - recipe quantities often need a
    // third decimal place (e.g. 0.125 kg = 125g).
    quantity: { type: 'numeric(10,3)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('menu_item_variant_ingredients', 'menu_item_variant_ingredients_unique', {
    unique: ['variant_id', 'ingredient_id'],
  });

  // Modifier option recipes - modifier options are always company-level
  // master data (6.4), even when attached to a local item, so there's no
  // local-item equivalent of this table either.
  pgm.createTable('modifier_option_ingredients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    modifier_option_id: { type: 'uuid', notNull: true, references: 'modifier_options' },
    ingredient_id: { type: 'uuid', notNull: true, references: 'ingredients' },
    quantity: { type: 'numeric(10,3)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('modifier_option_ingredients', 'modifier_option_ingredients_unique', {
    unique: ['modifier_option_id', 'ingredient_id'],
  });

  pgm.createIndex('menu_item_variant_ingredients', 'variant_id');
  pgm.createIndex('modifier_option_ingredients', 'modifier_option_id');
};

export const down = (pgm) => {
  pgm.dropTable('modifier_option_ingredients');
  pgm.dropTable('menu_item_variant_ingredients');
  pgm.dropColumns('shop_menu_item_ingredients', ['quantity', 'updated_at']);
  pgm.dropColumns('menu_item_ingredients', ['quantity', 'updated_at']);
  pgm.dropColumns('ingredients', ['unit']);
};
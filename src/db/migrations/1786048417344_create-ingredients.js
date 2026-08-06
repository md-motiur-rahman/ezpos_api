export const shorthands = undefined;

export const up = (pgm) => {
  // Master, company-level, reusable across items - "Wheat Flour" used in
  // many recipes, same reusability precedent as 6.4's modifier groups.
  pgm.createTable('ingredients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_id: { type: 'uuid', notNull: true, references: 'companies' },
    name: { type: 'text', notNull: true },
    // Validated at the app layer against the fixed ALLERGENS list (6.5).
    // Confirmed scope: allergen-tagging only, not anticipating Module 7's
    // future stock-tracking reuse - no quantity/stock columns here.
    allergens: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // A MASTER item's recipe. Pure current-state relationship - no
  // deleted_at, hard DELETE to detach, same reasoning as 6.4's join tables.
  pgm.createTable('menu_item_ingredients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    menu_item_id: { type: 'uuid', notNull: true, references: 'menu_items' },
    ingredient_id: { type: 'uuid', notNull: true, references: 'ingredients' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('menu_item_ingredients', 'menu_item_ingredients_unique', {
    unique: ['menu_item_id', 'ingredient_id'],
  });

  // Same relationship, one level down for shop-exclusive LOCAL items -
  // confirmed in scope directly. Separate table rather than a
  // polymorphic/nullable FK, same reasoning as every other master/local
  // split in Module 6.
  pgm.createTable('shop_menu_item_ingredients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_menu_item_id: { type: 'uuid', notNull: true, references: 'shop_menu_items' },
    ingredient_id: { type: 'uuid', notNull: true, references: 'ingredients' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('shop_menu_item_ingredients', 'shop_menu_item_ingredients_unique', {
    unique: ['shop_menu_item_id', 'ingredient_id'],
  });

  // No shop-level override table here, unlike items/variants/options -
  // an ingredient has no price or enabled-state of its own to override.

  pgm.createIndex('ingredients', 'company_id');
  pgm.createIndex('menu_item_ingredients', 'menu_item_id');
  pgm.createIndex('shop_menu_item_ingredients', 'shop_menu_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('shop_menu_item_ingredients');
  pgm.dropTable('menu_item_ingredients');
  pgm.dropTable('ingredients');
};
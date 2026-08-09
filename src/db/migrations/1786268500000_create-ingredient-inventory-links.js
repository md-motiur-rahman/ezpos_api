export const shorthands = undefined;

export const up = (pgm) => {
  // The missing bridge between Module 6/7.2's recipes and 7.1's stock:
  // ingredients are COMPANY-level master data ("Wheat Flour"), inventory
  // items are SHOP-level physical stock. 7.9's deduction engine can't work
  // without knowing which shop's stock row an ingredient actually draws
  // down, and that answer is necessarily per-shop - two branches can track
  // the same ingredient against differently-named/differently-united stock.
  pgm.createTable('ingredient_inventory_links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    ingredient_id: { type: 'uuid', notNull: true, references: 'ingredients' },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    // How many INVENTORY units one INGREDIENT unit consumes. Confirmed
    // directly over the stricter "units must match exactly" alternative:
    // a recipe measured in grams against stock tracked in 25kg sacks is a
    // real case, and forcing them to agree would make linking unusable.
    // numeric(12,6) - a gram-to-sack factor is 0.00004, so 6 decimal
    // places is the working minimum here, unlike the 3dp used for recipe
    // quantities and 2dp for money.
    conversion_factor: { type: 'numeric(12,6)', notNull: true, default: 1 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One ingredient resolves to exactly ONE stock item per shop - the
  // deduction engine needs an unambiguous answer, so this is a hard
  // constraint, not a convention. Note it's (shop, ingredient), NOT
  // (shop, ingredient, inventory_item): the point is to prevent a second
  // link for the same ingredient, whatever item it points at.
  pgm.addConstraint('ingredient_inventory_links', 'ingredient_inventory_links_unique', {
    unique: ['shop_id', 'ingredient_id'],
  });

  // No deleted_at, deliberately - a pure current-state join with no
  // independent existence, same as 6.4's menu_item_modifier_groups and
  // 7.2's recipe tables. Unlinking is a hard DELETE; nothing about a
  // past link is worth preserving, since the wastage/receipt log records
  // (7.6/7.7) are what carry the audit history of actual stock movement.

  pgm.createIndex('ingredient_inventory_links', 'shop_id');
  pgm.createIndex('ingredient_inventory_links', 'ingredient_id');
  pgm.createIndex('ingredient_inventory_links', 'inventory_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('ingredient_inventory_links');
};

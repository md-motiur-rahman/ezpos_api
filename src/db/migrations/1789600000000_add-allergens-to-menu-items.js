export const shorthands = undefined;

export const up = (pgm) => {
  // Allergens set directly on the dish ("Fried Chicken: gluten, egg"), for
  // shops that don't want to model ingredients just to tag them. The menu a
  // shop sees shows these together with any allergens carried in by an
  // ingredient in the item's recipe, so nothing already tagged is lost.
  // Same shape as ingredients.allergens: a text[] of values from ALLERGENS,
  // checked in code, never null.
  pgm.addColumn('menu_items', {
    allergens: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
  });
  pgm.addColumn('shop_menu_items', {
    allergens: { type: 'text[]', notNull: true, default: pgm.func("'{}'") },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('shop_menu_items', ['allergens']);
  pgm.dropColumns('menu_items', ['allergens']);
};

export const shorthands = undefined;

export const up = (pgm) => {
  // Sizes (Regular / Medium / Large) for a shop's OWN items. They live in the
  // same table as a master item's sizes on purpose: orders already point
  // order_items.variant_id at menu_item_variants, so an order for a shop-only
  // item's size needs no new column, and the kitchen, the receipt and stock
  // deduction keep reading the size the way they always have.
  //
  // A size belongs to exactly one of the two kinds of item, never both and
  // never neither. Every existing row has menu_item_id set, so the check holds
  // for all of them from the start. Master-side queries all JOIN on
  // menu_item_id, which is why a shop item's size can never leak into a
  // company-wide list.
  pgm.alterColumn('menu_item_variants', 'menu_item_id', { notNull: false });
  pgm.addColumn('menu_item_variants', {
    shop_menu_item_id: { type: 'uuid', references: 'shop_menu_items' },
  });
  pgm.addConstraint('menu_item_variants', 'menu_item_variants_exactly_one_parent', {
    check: '(menu_item_id IS NULL) <> (shop_menu_item_id IS NULL)',
  });
  pgm.createIndex('menu_item_variants', 'shop_menu_item_id');
};

export const down = (pgm) => {
  pgm.dropIndex('menu_item_variants', 'shop_menu_item_id');
  pgm.dropConstraint('menu_item_variants', 'menu_item_variants_exactly_one_parent');
  // Shop-item sizes have no master parent to fall back on, so they go.
  pgm.sql('DELETE FROM menu_item_variants WHERE menu_item_id IS NULL');
  pgm.dropColumns('menu_item_variants', ['shop_menu_item_id']);
  pgm.alterColumn('menu_item_variants', 'menu_item_id', { notNull: true });
};

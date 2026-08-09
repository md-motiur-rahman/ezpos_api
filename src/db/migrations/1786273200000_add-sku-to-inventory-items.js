export const shorthands = undefined;

export const up = (pgm) => {
  // Nullable - not every item is barcode-tracked (e.g. in-house prepped
  // items). Partial unique index rather than a plain UNIQUE constraint:
  // multiple items must be free to have no SKU at all, and only a
  // CONFIGURED sku needs to be unique - same "partial uniqueness" need as
  // 7.4's one-default-per-item index.
  //
  // Scoped to (shop_id, sku), NOT company-wide or global: the SAME real
  // barcode (e.g. a Coca-Cola can) legitimately recurs across every shop in
  // a chain, since each shop has its own separate inventory_items row for
  // it. A company-wide unique constraint would incorrectly block the
  // second shop from ever using that barcode.
  pgm.addColumn('inventory_items', {
    sku: { type: 'text' },
  });

  pgm.createIndex('inventory_items', ['shop_id', 'sku'], {
    unique: true,
    where: 'sku IS NOT NULL',
    name: 'inventory_items_one_sku_per_shop',
  });
};

export const down = (pgm) => {
  pgm.dropIndex('inventory_items', ['shop_id', 'sku'], {
    name: 'inventory_items_one_sku_per_shop',
  });
  pgm.dropColumns('inventory_items', ['sku']);
};

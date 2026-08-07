export const shorthands = undefined;

export const up = (pgm) => {
  // Nullable: most items may never need alerting configured. NULL means
  // "not tracked for low-stock" - never confused with a threshold of 0.
  // Same unit as the item's own `unit` column - no separate unit needed.
  pgm.addColumn('inventory_items', {
    low_stock_threshold: { type: 'numeric(10,2)' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('inventory_items', ['low_stock_threshold']);
};
export const shorthands = undefined;

export const up = (pgm) => {
  // Nullable, no default - same convention as low_stock_threshold (7.3):
  // most items may never need shelf-life tracking configured, and NULL
  // means "not tracked", never confused with a configured value of 0.
  //
  // Two separate columns, not one: a sealed/unopened item and an
  // opened/prepped one run on genuinely different clocks in real food
  // safety practice (e.g. "best before 6 months, use within 3 days once
  // opened"), confirmed directly over a single duration.
  //
  // Whole days, not hours - confirmed directly as the working granularity
  // for 8.1. Doesn't fit same-day prepped items (a 6-hour salad) precisely,
  // but matches the common case and keeps 8.2's expiry math simple.
  pgm.addColumn('inventory_items', {
    shelf_life_days: { type: 'integer' },
    shelf_life_opened_days: { type: 'integer' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('inventory_items', ['shelf_life_days', 'shelf_life_opened_days']);
};

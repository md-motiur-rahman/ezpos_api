export const shorthands = undefined;

export const up = (pgm) => {
  // Stock is now counted in grams/millilitres, so a supplier's £3.50 per kg
  // is £0.0035 per gram - which numeric(10,2) rounded to £0.00. Ten decimals
  // keeps a line total (price / quantity) exact enough that multiplying it
  // back by the quantity lands on the same pennies, even for 100 kg.
  // Existing 2dp values convert unchanged.
  pgm.alterColumn('purchase_order_items', 'unit_cost', { type: 'numeric(18,10)' });
};

export const down = (pgm) => {
  pgm.alterColumn('purchase_order_items', 'unit_cost', {
    type: 'numeric(10,2)',
    using: 'round(unit_cost, 2)',
  });
};

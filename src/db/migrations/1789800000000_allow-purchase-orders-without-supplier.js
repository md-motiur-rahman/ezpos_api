/* eslint-disable camelcase */

// A purchase can come from a market or supermarket with no supplier on file.
export const up = (pgm) => {
  pgm.alterColumn('purchase_orders', 'supplier_id', { notNull: false });
};

export const down = (pgm) => {
  pgm.alterColumn('purchase_orders', 'supplier_id', { notNull: true });
};

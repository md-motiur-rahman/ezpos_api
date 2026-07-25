export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('companies', {
    stripe_customer_id: { type: 'text', unique: true },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'stripe_customer_id');
};
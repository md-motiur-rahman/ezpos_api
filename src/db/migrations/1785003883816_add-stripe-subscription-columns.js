export const shorthands = undefined;

export const up = (pgm) => {
  // One subscription per company (all shops + add-ons are line items on it),
  // so the chain owner gets a single consolidated invoice.
  pgm.addColumn('companies', {
    stripe_subscription_id: { type: 'text', unique: true },
  });

  // Each shop is one line item on that subscription.
  pgm.addColumn('shops', {
    stripe_subscription_item_id: { type: 'text', unique: true },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('shops', 'stripe_subscription_item_id');
  pgm.dropColumn('companies', 'stripe_subscription_id');
};
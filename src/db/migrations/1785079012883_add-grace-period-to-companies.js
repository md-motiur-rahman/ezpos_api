export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('companies', {
    // Set when the first invoice payment failure arrives, cleared when payment
    // succeeds. Deliberately NOT extended by Stripe's subsequent retries of the
    // same invoice - see billing.service.js.
    grace_period_ends_at: { type: 'timestamptz' },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'grace_period_ends_at');
};
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('companies', {
    // 'platform' | 'own' - validated at the app layer (zod), same convention
    // as business_type on this table.
    //
    // 'platform' = card payments route through paymentProvider.js (9.5's
    //              seam, Module 13's real vendor later) - the behaviour that
    //              has always existed.
    // 'own'      = the shop already has its own bank-supplied card terminal.
    //              The till still offers cash/card and still RECORDS the
    //              transaction as 'card'; we simply never call a provider,
    //              because the money was taken out of band on their machine.
    //
    // DELIBERATELY unlike business_type, which is nullable with no default
    // because it is a genuine onboarding decision that must be stated. This
    // one is NOT NULL DEFAULT 'platform' precisely so every company that
    // already exists - and every future caller that never mentions it -
    // keeps exactly today's behaviour. That makes 9.5/9.6 regression-proof
    // by construction rather than by remembering to re-test it.
    card_payment_mode: { type: 'text', notNull: true, default: 'platform' },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'card_payment_mode');
};

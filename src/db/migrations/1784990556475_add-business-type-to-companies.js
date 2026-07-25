export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('companies', {
    // 'single' | 'chain' - validated at the app layer (zod), same pattern
    // already used for verification_tokens.purpose. Nullable and not
    // defaulted: this is a deliberate onboarding choice, not an assumption.
    business_type: { type: 'text' },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'business_type');
};
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('companies', {
    // Set once, the first time this company ever gets a subscription.
    // Its presence (not its date) is what marks the trial as already used -
    // closing every shop and reopening must not grant a second free trial.
    trial_ends_at: { type: 'timestamptz' },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('companies', 'trial_ends_at');
};
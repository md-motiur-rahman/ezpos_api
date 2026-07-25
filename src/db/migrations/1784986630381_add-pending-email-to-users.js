export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumn('users', {
    pending_email: { type: 'citext' },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('users', 'pending_email');
};
export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('staff_sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    // Raw token returned once at login, only the hash stored - same pattern
    // as refresh_tokens.
    token_hash: { type: 'text', notNull: true, unique: true },
    // Slides forward on every authenticated request. 60 minutes of
    // inactivity is checked at request time (isSessionExpired), not enforced
    // here - no cleanup job needed for correctness.
    last_active_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  });

  pgm.createIndex('staff_sessions', 'token_hash');
  pgm.createIndex('staff_sessions', 'staff_id');
};

export const down = (pgm) => {
  pgm.dropTable('staff_sessions');
};
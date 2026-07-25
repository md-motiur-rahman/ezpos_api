export const shorthands = undefined;

export const up = (pgm) => {
  // citext gives case-insensitive text comparison at the database level -
  // 'Foo@Bar.com' and 'foo@bar.com' are treated as the same value, so the
  // unique constraint on email actually behaves the way email addresses do.
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'citext', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    email_verified_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createTable('verification_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    token_hash: { type: 'text', notNull: true },
    purpose: { type: 'text', notNull: true }, // 'email_verification' | 'password_reset'
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Every lookup of a token during verification/reset is by its hash - index it.
  pgm.createIndex('verification_tokens', 'token_hash');
  // Used when issuing a new token to find/invalidate any existing ones for that user+purpose.
  pgm.createIndex('verification_tokens', ['user_id', 'purpose']);
};

export const down = (pgm) => {
  pgm.dropTable('verification_tokens');
  pgm.dropTable('users');
  pgm.dropExtension('citext');
};
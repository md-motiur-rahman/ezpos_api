export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('refresh_tokens', 'token_hash');
  pgm.createIndex('refresh_tokens', 'user_id');
};

export const down = (pgm) => {
  pgm.dropTable('refresh_tokens');
};
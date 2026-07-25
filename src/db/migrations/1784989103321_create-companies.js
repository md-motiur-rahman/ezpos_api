export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('companies', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    owner_user_id: { type: 'uuid', notNull: true, references: 'users' },
    name: { type: 'text', notNull: true },
    address_line1: { type: 'text', notNull: true },
    address_line2: { type: 'text' },
    city: { type: 'text', notNull: true },
    postcode: { type: 'text', notNull: true },
    country: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    vat_number: { type: 'text' },
    company_number: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // Partial unique index: one ACTIVE company per owner, but a soft-deleted
  // company doesn't block that owner from creating a new one later.
  pgm.createIndex('companies', 'owner_user_id', {
    unique: true,
    where: 'deleted_at IS NULL',
    name: 'companies_one_active_per_owner',
  });
};

export const down = (pgm) => {
  pgm.dropTable('companies');
};
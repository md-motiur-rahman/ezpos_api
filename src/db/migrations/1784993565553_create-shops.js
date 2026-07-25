export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('shops', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_id: { type: 'uuid', notNull: true, references: 'companies' },
    name: { type: 'text', notNull: true },
    address_line1: { type: 'text', notNull: true },
    address_line2: { type: 'text' },
    city: { type: 'text', notNull: true },
    postcode: { type: 'text', notNull: true },
    country: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createIndex('shops', 'company_id');
};

export const down = (pgm) => {
  pgm.dropTable('shops');
};
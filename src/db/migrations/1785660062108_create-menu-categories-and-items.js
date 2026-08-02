export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('menu_categories', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    company_id: { type: 'uuid', notNull: true, references: 'companies' },
    name: { type: 'text', notNull: true },
    display_order: { type: 'integer', notNull: true, default: 0 },
    // Distinct from soft-delete: a category with items can't be deleted, but
    // CAN be toggled inactive (e.g. seasonal/temporarily unavailable) as an
    // alternative. Deleted = gone from management entirely; inactive =
    // still visible/manageable but not "live".
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createTable('menu_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    category_id: { type: 'uuid', notNull: true, references: 'menu_categories' },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    price: { type: 'numeric(10,2)', notNull: true },
    display_order: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
    // No company_id - an item's company is always implied by its category's
    // company (JOIN menu_categories), same pattern as rota_shifts scoping
    // via JOIN staff rather than a redundant, driftable column.
  });

  pgm.createIndex('menu_categories', 'company_id');
  pgm.createIndex('menu_items', 'category_id');
};

export const down = (pgm) => {
  pgm.dropTable('menu_items');
  pgm.dropTable('menu_categories');
};
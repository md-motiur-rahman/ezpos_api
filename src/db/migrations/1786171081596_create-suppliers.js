export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop, matching inventory_items' own scope exactly - a supplier
  // delivers to a specific shop address, same reasoning as 7.1's decision
  // not to make inventory company-level like Module 6's menu.
  pgm.createTable('suppliers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    name: { type: 'text', notNull: true },
    contact_name: { type: 'text' },
    phone: { type: 'text' },
    email: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // Many-to-many: an item can be bought from several suppliers, one
  // (optionally) flagged as the default - the "chicken breast defaults to
  // Bidfood but can also come from another vendor" case, confirmed directly.
  pgm.createTable('inventory_item_suppliers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    supplier_id: { type: 'uuid', notNull: true, references: 'suppliers' },
    is_default: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('inventory_item_suppliers', 'inventory_item_suppliers_unique', {
    unique: ['inventory_item_id', 'supplier_id'],
  });

  // DB-level safety net: at most one default supplier per item, enforced
  // even against an application bug, not just relied on via app logic. A
  // partial index (only rows where is_default = true) - most rows won't be
  // in it, so it doesn't serve general lookups; the plain index below does.
  pgm.createIndex('inventory_item_suppliers', 'inventory_item_id', {
    name: 'inventory_item_suppliers_one_default_per_item',
    unique: true,
    where: 'is_default = true',
  });

  pgm.createIndex('suppliers', 'shop_id');
  pgm.createIndex('inventory_item_suppliers', 'inventory_item_id');
  pgm.createIndex('inventory_item_suppliers', 'supplier_id');
};

export const down = (pgm) => {
  pgm.dropTable('inventory_item_suppliers');
  pgm.dropTable('suppliers');
};
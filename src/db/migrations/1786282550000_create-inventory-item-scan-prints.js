export const shorthands = undefined;

export const up = (pgm) => {
  // A print/reprint EVENT against a scan (8.3). Multiple prints per scan
  // are deliberately allowed - a damaged label just gets reprinted - same
  // "multiple receipts per PO" precedent as 7.6. Deliberately NO deleted_at
  // and no update/delete anywhere - immutable once created, same reasoning
  // as inventory_item_scans itself (8.2): this represents an already-
  // applied real-world event (a physical print), not configuration.
  //
  // shop_id is denormalized (also reachable via scan_id -> shop_id) -
  // matches the same scoping convention already used on
  // inventory_item_scans itself, direct WHERE clause rather than a join
  // for every shop-scoped query.
  pgm.createTable('inventory_item_scan_prints', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    scan_id: { type: 'uuid', notNull: true, references: 'inventory_item_scans' },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    printed_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('inventory_item_scan_prints', 'scan_id');
  pgm.createIndex('inventory_item_scan_prints', 'shop_id');
};

export const down = (pgm) => {
  pgm.dropTable('inventory_item_scan_prints');
};

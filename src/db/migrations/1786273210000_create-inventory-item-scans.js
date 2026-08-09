export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop, matching wastage_logs' own scope (7.7). Deliberately NO
  // deleted_at - immutable once created, same reasoning as 7.6/7.7: this
  // represents an already-applied real-world event (a physical scan), not
  // ongoing configuration. There's nothing to "correct" here - a bad scan
  // is just re-scanned; 8.1's PATCH on the item itself is what corrects
  // shelf-life CONFIGURATION.
  pgm.createTable('inventory_item_scans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    // Captured independently of inventory_items.sku (not just a join at
    // read time) so this record stays historically accurate even if the
    // item's own sku is edited or cleared later.
    sku: { type: 'text', notNull: true },
    // Validated at the app layer against the fixed SCAN_STATES list - same
    // code-constant precedent as 7.7's WASTAGE_REASONS, not a DB enum type.
    state: { type: 'text', notNull: true },
    // Which of 8.1's two duration fields actually applied at scan time,
    // captured as a value (not just re-derived from `state` via a join) -
    // 8.1's configuration can change later, and this keeps the log honest
    // about what was true at the moment of the scan.
    shelf_life_days_used: { type: 'integer', notNull: true },
    scanned_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // DATE, not TIMESTAMPTZ - this is a calendar "use by" date for a
    // printed label, not a precise moment in time.
    expires_on: { type: 'date', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('inventory_item_scans', 'shop_id');
  pgm.createIndex('inventory_item_scans', 'inventory_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('inventory_item_scans');
};

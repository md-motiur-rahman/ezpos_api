export const shorthands = undefined;

export const up = (pgm) => {
  // Closes the loop opened by 8.4's "expired" flag list. Deliberately a
  // SEPARATE new table rather than a column added to inventory_item_scans
  // (8.2) - that table was shipped as fully immutable ("no PATCH/DELETE at
  // all") and stays that way; resolving a flag is its OWN already-applied
  // event, same reasoning as 8.3's inventory_item_scan_prints being a
  // separate table rather than a mutation on the scan itself.
  //
  // wastage_log_id is NULLABLE and NOT a foreign key requirement of the
  // resolve action - confirmed directly. A flag can be closed either by
  // pointing at the 7.7 wastage log that disposed of the item, or by a
  // plain dismissal (false alarm, already used up, mis-scanned) with no
  // wastage behind it at all. 8.4 never creates a wastage_log itself -
  // that stays entirely 7.7's job, unchanged.
  pgm.createTable('inventory_item_scan_resolutions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    scan_id: { type: 'uuid', notNull: true, references: 'inventory_item_scans' },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    wastage_log_id: { type: 'uuid', references: 'wastage_logs' },
    notes: { type: 'text' },
    resolved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One resolution per scan - once a flag is dealt with, it's dealt with.
  // No "un-resolve" mechanism, same as every other immutable-log table in
  // this project having no reversal mechanism (Section 2) - a mistaken
  // resolution isn't expected to need correcting, unlike a mistaken stock
  // quantity (which 7.1's PATCH exists for).
  pgm.addConstraint('inventory_item_scan_resolutions', 'inventory_item_scan_resolutions_unique_scan', {
    unique: ['scan_id'],
  });

  pgm.createIndex('inventory_item_scan_resolutions', 'shop_id');
  pgm.createIndex('inventory_item_scan_resolutions', 'wastage_log_id');
};

export const down = (pgm) => {
  pgm.dropTable('inventory_item_scan_resolutions');
};

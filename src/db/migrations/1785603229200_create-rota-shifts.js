export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('rota_shifts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    start_time: { type: 'timestamptz', notNull: true },
    end_time: { type: 'timestamptz', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // No shop_id column - shop scoping is derived via JOIN staff (same pattern
  // as 4.6's audit log). Staff don't currently transfer between shops, so
  // there's nothing to keep in sync by duplicating it here.
  pgm.createIndex('rota_shifts', 'staff_id');
  // Supports the date-range query (?from=&to=) efficiently.
  pgm.createIndex('rota_shifts', ['start_time', 'end_time']);
};

export const down = (pgm) => {
  pgm.dropTable('rota_shifts');
};
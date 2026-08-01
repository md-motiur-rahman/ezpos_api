export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('shift_swap_requests', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shift_id: { type: 'uuid', notNull: true, references: 'rota_shifts' },
    // Snapshot of who the shift belonged to at request time.
    from_staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    to_staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    // Polymorphic (owner or staff), same pattern as 4.6's granted_by.
    requested_by_type: { type: 'text', notNull: true },
    requested_by_id: { type: 'uuid', notNull: true },
    status: { type: 'text', notNull: true, default: 'pending' },
    decided_by_type: { type: 'text' },
    decided_by_id: { type: 'uuid' },
    decided_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // No deleted_at - a decided request's resolved status IS the historical
    // record, same reasoning as 4.6's audit table.
  });

  // One PENDING request per shift at a time.
  pgm.createIndex('shift_swap_requests', 'shift_id', {
    unique: true,
    where: "status = 'pending'",
    name: 'shift_swap_requests_one_pending_per_shift',
  });
};

export const down = (pgm) => {
  pgm.dropTable('shift_swap_requests');
};
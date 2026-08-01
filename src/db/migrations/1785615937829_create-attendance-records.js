export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('attendance_records', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    // Both timestamps are server-set (now()) at clock-in/out time - never
    // client-supplied, to avoid clock-skew or manipulation on a real-time
    // till action.
    clocked_in_at: { type: 'timestamptz', notNull: true },
    clocked_out_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Deliberately NOT linked to a specific rota_shift_id - staff sometimes
    // work unscheduled hours or cover extra shifts. 5.4 compares against the
    // rota by staff_id + overlapping time range, not a foreign key.
  });

  // One OPEN (still clocked in) record per staff member at a time.
  pgm.createIndex('attendance_records', 'staff_id', {
    unique: true,
    where: 'clocked_out_at IS NULL',
    name: 'attendance_records_one_open_per_staff',
  });
  pgm.createIndex('attendance_records', ['clocked_in_at', 'clocked_out_at']);
};

export const down = (pgm) => {
  pgm.dropTable('attendance_records');
};
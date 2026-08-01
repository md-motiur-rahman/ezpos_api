export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('staff_permission_overrides', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    staff_id: { type: 'uuid', notNull: true, references: 'staff' },
    // Validated at the app layer against PERMISSIONS (4.1).
    permission: { type: 'text', notNull: true },
    // Nullable: the Owner can grant too, and the Owner isn't a staff row.
    granted_by: { type: 'uuid', references: 'staff' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
    // No deleted_at - this row's grant/revoke history IS the audit trail
    // (Module 4.6 reads it directly), a soft-delete column would duplicate
    // revoked_at's job.
  });

  // One ACTIVE override per permission per staff member.
  pgm.createIndex('staff_permission_overrides', ['staff_id', 'permission'], {
    unique: true,
    where: 'revoked_at IS NULL',
    name: 'staff_permission_overrides_one_active_per_permission',
  });
};

export const down = (pgm) => {
  pgm.dropTable('staff_permission_overrides');
};
export const shorthands = undefined;

export const up = (pgm) => {
  // granted_by was a FK to staff, nullable only when the Owner acted (the
  // code used `actor.type === 'staff' ? actor.id : null`). It's now
  // polymorphic - can hold either a staff.id or a users.id - so the FK
  // constraint must go. Renamed to granted_by_id for symmetry with the new
  // revoked_by_id/revoked_by_type pair below.
  pgm.dropConstraint('staff_permission_overrides', 'staff_permission_overrides_granted_by_fkey');
  pgm.renameColumn('staff_permission_overrides', 'granted_by', 'granted_by_id');

  pgm.addColumns('staff_permission_overrides', {
    // 'owner' | 'staff'. Added nullable, backfilled below, then constrained
    // NOT NULL - required because this table may already have rows.
    granted_by_type: { type: 'text' },
    revoked_by_type: { type: 'text' },
    revoked_by_id: { type: 'uuid' },
  });

  // Backfill is exact, not a guess: under the pre-4.6 code, granted_by_id
  // was NULL if and only if the Owner acted (the only other branch), and
  // non-null if and only if a staff member acted.
  pgm.sql(
    `UPDATE staff_permission_overrides SET granted_by_type = 'staff' WHERE granted_by_id IS NOT NULL`
  );
  pgm.sql(`UPDATE staff_permission_overrides SET granted_by_type = 'owner' WHERE granted_by_id IS NULL`);
  pgm.alterColumn('staff_permission_overrides', 'granted_by_type', { notNull: true });
};

export const down = (pgm) => {
  pgm.dropColumns('staff_permission_overrides', ['granted_by_type', 'revoked_by_type', 'revoked_by_id']);
  pgm.renameColumn('staff_permission_overrides', 'granted_by_id', 'granted_by');
  pgm.addConstraint('staff_permission_overrides', 'staff_permission_overrides_granted_by_fkey', {
    foreignKeys: { columns: 'granted_by', references: 'staff' },
  });
};
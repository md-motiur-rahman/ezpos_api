export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('staff', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    full_name: { type: 'text', notNull: true },
    // Validated at the app layer against ROLES (4.1), excluding 'owner' -
    // the Owner is never a staff row, they're the users/companies owner.
    role: { type: 'text', notNull: true },
    // System-generated 8-digit numeric string, unique per shop. Used for
    // PIN login (4.3) alongside the PIN itself.
    staff_id_code: { type: 'text', notNull: true },
    // bcrypt hash, same as passwords - the raw PIN is never stored, only
    // ever returned once at creation time.
    pin_hash: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // One ACTIVE staff_id_code per shop - matches the partial-unique pattern
  // used everywhere else in this project (companies, shop_addons, ...).
  pgm.createIndex('staff', ['shop_id', 'staff_id_code'], {
    unique: true,
    where: 'deleted_at IS NULL',
    name: 'staff_one_active_id_code_per_shop',
  });
};

export const down = (pgm) => {
  pgm.dropTable('staff');
};
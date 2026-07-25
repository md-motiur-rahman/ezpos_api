export const shorthands = undefined;

export const up = (pgm) => {
  pgm.createTable('shop_addons', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    // 'health_safety' for now - validated at the app layer (zod enum), same
    // pattern as verification_tokens.purpose.
    addon_type: { type: 'text', notNull: true },
    // Each active add-on is its own line item on the company's subscription.
    stripe_subscription_item_id: { type: 'text', unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    deleted_at: { type: 'timestamptz' },
  });

  // One ACTIVE add-on of a given type per shop. Deactivating soft-deletes the
  // row, so reactivating later creates a fresh one - which leaves a full
  // activation/deactivation history behind for billing history (3.7).
  pgm.createIndex('shop_addons', ['shop_id', 'addon_type'], {
    unique: true,
    where: 'deleted_at IS NULL',
    name: 'shop_addons_one_active_per_type',
  });
};

export const down = (pgm) => {
  pgm.dropTable('shop_addons');
};
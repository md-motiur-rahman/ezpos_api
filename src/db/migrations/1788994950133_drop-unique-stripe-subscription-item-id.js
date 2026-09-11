export const shorthands = undefined;

/**
 * A company's shops all share ONE Stripe subscription item for the shop price,
 * with its quantity tracking how many shops are active - the standard Stripe
 * per-seat pattern. Stripe rejects a second subscription item referencing a
 * Price already on the subscription, which is why one-item-per-shop could
 * never work: creating a chain's second shop always failed, and the catch
 * block in createShop silently rolled the shop back.
 *
 * That shared id has to be storable on several rows at once, so the UNIQUE
 * constraint has to go. Verified empirically before writing this: with the
 * constraint in place, a second shop row carrying the same item id is
 * rejected with 23505 on shops_stripe_subscription_item_id_key - i.e. keeping
 * it would merely trade Stripe's error for Postgres's.
 *
 * Same reasoning for shop_addons: one item per (company, addon_type), shared
 * by every shop in the company that has that add-on active.
 *
 * A plain (non-unique) index replaces each constraint - the lookup of "which
 * item id is this company already using" still needs to be fast, it just no
 * longer needs to be unique.
 */
export const up = (pgm) => {
  pgm.dropConstraint('shops', 'shops_stripe_subscription_item_id_key');
  pgm.dropConstraint('shop_addons', 'shop_addons_stripe_subscription_item_id_key');

  pgm.createIndex('shops', 'stripe_subscription_item_id', {
    name: 'shops_stripe_subscription_item_id_idx',
  });
  pgm.createIndex('shop_addons', 'stripe_subscription_item_id', {
    name: 'shop_addons_stripe_subscription_item_id_idx',
  });
};

/**
 * Reversible only while no two rows actually share an id - which is true of
 * any database that hasn't yet had a chain company add its second shop under
 * the new behaviour. Past that point this down migration will (correctly)
 * fail rather than silently discard billing state.
 */
export const down = (pgm) => {
  pgm.dropIndex('shops', 'stripe_subscription_item_id', {
    name: 'shops_stripe_subscription_item_id_idx',
  });
  pgm.dropIndex('shop_addons', 'stripe_subscription_item_id', {
    name: 'shop_addons_stripe_subscription_item_id_idx',
  });

  pgm.addConstraint('shops', 'shops_stripe_subscription_item_id_key', {
    unique: ['stripe_subscription_item_id'],
  });
  pgm.addConstraint('shop_addons', 'shop_addons_stripe_subscription_item_id_key', {
    unique: ['stripe_subscription_item_id'],
  });
};

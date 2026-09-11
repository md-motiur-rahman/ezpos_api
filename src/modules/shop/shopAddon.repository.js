import { query } from '../../db/pool.js';

const COLUMNS = `id, shop_id, addon_type, stripe_subscription_item_id, created_at, updated_at`;

/** Throws Postgres unique-violation (23505) if this add-on is already active on this shop. */
export async function createAddon(shopId, addonType) {
  const { rows } = await query(
    `INSERT INTO shop_addons (shop_id, addon_type) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [shopId, addonType]
  );
  return rows[0];
}

export async function listActiveAddonsForShop(shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shop_addons
     WHERE shop_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [shopId]
  );
  return rows;
}

export async function findActiveAddon(shopId, addonType) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM shop_addons
     WHERE shop_id = $1 AND addon_type = $2 AND deleted_at IS NULL`,
    [shopId, addonType]
  );
  return rows[0] ?? null;
}

export async function setStripeSubscriptionItemId(id, stripeSubscriptionItemId) {
  await query(
    `UPDATE shop_addons SET stripe_subscription_item_id = $1, updated_at = now() WHERE id = $2`,
    [stripeSubscriptionItemId, id]
  );
}

export async function softDeleteAddon(id) {
  await query(`UPDATE shop_addons SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

/**
 * Add-ons are billed exactly like shops are: ONE Stripe line item per
 * (company, addon_type), shared by every shop in the company with that
 * add-on active, with quantity as the count. These two are the
 * company-wide view the per-shop queries above can't give.
 *
 * Both join through shops because shop_addons has no company_id of its own -
 * it reaches its company only via its shop, same as order_item_modifiers
 * reaching its order only via order_items.
 */
export async function findSharedStripeItemIdForCompanyAddon(companyId, addonType) {
  const { rows } = await query(
    `SELECT sa.stripe_subscription_item_id FROM shop_addons sa
     JOIN shops s ON s.id = sa.shop_id
     WHERE s.company_id = $1 AND sa.addon_type = $2
       AND sa.deleted_at IS NULL AND s.deleted_at IS NULL
       AND sa.stripe_subscription_item_id IS NOT NULL
     LIMIT 1`,
    [companyId, addonType]
  );
  return rows[0]?.stripe_subscription_item_id ?? null;
}

export async function countActiveAddonsOfTypeForCompany(companyId, addonType) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM shop_addons sa
     JOIN shops s ON s.id = sa.shop_id
     WHERE s.company_id = $1 AND sa.addon_type = $2
       AND sa.deleted_at IS NULL AND s.deleted_at IS NULL`,
    [companyId, addonType]
  );
  return rows[0].count;
}

/** Used when a shop closes - all its add-ons go with it. */
export async function softDeleteAllAddonsForShop(shopId) {
  await query(
    `UPDATE shop_addons SET deleted_at = now(), updated_at = now()
     WHERE shop_id = $1 AND deleted_at IS NULL`,
    [shopId]
  );
}
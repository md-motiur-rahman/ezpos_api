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

/** Used when a shop closes - all its add-ons go with it. */
export async function softDeleteAllAddonsForShop(shopId) {
  await query(
    `UPDATE shop_addons SET deleted_at = now(), updated_at = now()
     WHERE shop_id = $1 AND deleted_at IS NULL`,
    [shopId]
  );
}
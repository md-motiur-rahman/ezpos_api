import { query } from '../../db/pool.js';

/** Only aliases whose stock item still exists - a deleted item's wordings are dead weight. */
export async function listForShop(shopId) {
  const { rows } = await query(
    `SELECT ra.wording, ra.inventory_item_id
     FROM receipt_aliases ra
     JOIN inventory_items ii ON ii.id = ra.inventory_item_id
     WHERE ra.shop_id = $1 AND ii.deleted_at IS NULL
     ORDER BY ra.wording`,
    [shopId]
  );
  return rows;
}

/**
 * Callers must pass each wording at most once: two rows for the same key in
 * one INSERT ... ON CONFLICT DO UPDATE raise "cannot affect row a second
 * time".
 */
export async function upsertMany(shopId, wordings, inventoryItemIds) {
  await query(
    `INSERT INTO receipt_aliases (shop_id, wording, inventory_item_id)
     SELECT $1, w, i FROM unnest($2::text[], $3::uuid[]) AS t(w, i)
     ON CONFLICT (shop_id, wording)
     DO UPDATE SET inventory_item_id = EXCLUDED.inventory_item_id, updated_at = now()`,
    [shopId, wordings, inventoryItemIds]
  );
}

import { query } from '../../db/pool.js';

const SCAN_COLUMNS = `s.id, s.shop_id, s.inventory_item_id, s.sku, s.state,
                      s.shelf_life_days_used, s.scanned_at, s.expires_on,
                      s.created_at, s.updated_at`;

// Joined for the item's name/unit only (display purposes) - deliberately
// NOT quantity_on_hand or low_stock_threshold. This endpoint is gated on
// PERFORM_HEALTH_SAFETY (8.2), a broader permission than VIEW_INVENTORY, so
// pulling stock-level fields through here would leak back-of-house data to
// roles (Server, Shift Manager) who don't otherwise have it by default.
const ITEM_JOIN = `JOIN inventory_items ii ON ii.id = s.inventory_item_id`;

/**
 * Immutable once created (8.2) - no update/delete function exists here at
 * all, same as 7.6's receipts and 7.7's wastage logs. `expires_on` is
 * computed by the service layer (today + whichever shelf-life duration
 * applied) and passed in already calculated, not derived in SQL - the
 * calculation itself has no DB-specific behavior worth pushing down.
 */
export async function createScan(
  shopId,
  { inventoryItemId, sku, state, shelfLifeDaysUsed, expiresOn }
) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO inventory_item_scans
         (shop_id, inventory_item_id, sku, state, shelf_life_days_used, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inserted s
     ${ITEM_JOIN}`,
    [shopId, inventoryItemId, sku, state, shelfLifeDaysUsed, expiresOn]
  );
  return rows[0];
}

export async function listScansForShop(shopId) {
  const { rows } = await query(
    `SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inventory_item_scans s
     ${ITEM_JOIN}
     WHERE s.shop_id = $1
     ORDER BY s.scanned_at DESC`,
    [shopId]
  );
  return rows;
}

export async function findScanByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inventory_item_scans s
     ${ITEM_JOIN}
     WHERE s.id = $1 AND s.shop_id = $2`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

import { query } from '../../db/pool.js';

const WASTAGE_LOG_COLUMNS = `id, shop_id, wasted_at, notes, created_at, updated_at`;

export async function createWastageLog(shopId, { wastedAt, notes }) {
  const { rows } = await query(
    `INSERT INTO wastage_logs (shop_id, wasted_at, notes)
     VALUES ($1, COALESCE($2, now()), $3)
     RETURNING ${WASTAGE_LOG_COLUMNS}`,
    [shopId, wastedAt ?? null, notes ?? null]
  );
  return rows[0];
}

/** Same bulk-insert-via-unnest() pattern as 7.5/7.6 - one atomic statement, verified empirically including NULL notes mixed with real ones. */
export async function createWastageLogItems(wastageLogId, items) {
  const itemIds = items.map((i) => i.inventoryItemId);
  const quantities = items.map((i) => i.quantityWasted);
  const reasons = items.map((i) => i.reason);
  const notesArr = items.map((i) => i.notes ?? null);
  const { rows } = await query(
    `INSERT INTO wastage_log_items (wastage_log_id, inventory_item_id, quantity_wasted, reason, notes)
     SELECT $1, unnest($2::uuid[]), unnest($3::numeric[]), unnest($4::text[]), unnest($5::text[])
     RETURNING id, wastage_log_id, inventory_item_id, quantity_wasted, reason, notes, created_at`,
    [wastageLogId, itemIds, quantities, reasons, notesArr]
  );
  return rows;
}

export async function listWastageLogsForShop(shopId) {
  const { rows } = await query(
    `SELECT wl.id, wl.shop_id, wl.wasted_at, wl.notes, wl.created_at, wl.updated_at,
            count(wli.id)::int AS item_count
     FROM wastage_logs wl
     LEFT JOIN wastage_log_items wli ON wli.wastage_log_id = wl.id
     WHERE wl.shop_id = $1
     GROUP BY wl.id
     ORDER BY wl.wasted_at DESC`,
    [shopId]
  );
  return rows;
}

export async function findWastageLogByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${WASTAGE_LOG_COLUMNS} FROM wastage_logs WHERE id = $1 AND shop_id = $2`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function listItemsForWastageLog(wastageLogId) {
  const { rows } = await query(
    `SELECT wli.id, wli.inventory_item_id, ii.name AS item_name, ii.unit,
            wli.quantity_wasted, wli.reason, wli.notes, wli.created_at
     FROM wastage_log_items wli
     JOIN inventory_items ii ON ii.id = wli.inventory_item_id
     WHERE wli.wastage_log_id = $1
     ORDER BY ii.name`,
    [wastageLogId]
  );
  return rows;
}
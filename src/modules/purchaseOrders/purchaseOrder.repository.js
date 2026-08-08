import { query } from '../../db/pool.js';

const PO_COLUMNS = `id, shop_id, supplier_id, ordered_at, notes, created_at, updated_at`;

export async function createPurchaseOrder(shopId, { supplierId, orderedAt, notes }) {
  const { rows } = await query(
    `INSERT INTO purchase_orders (shop_id, supplier_id, ordered_at, notes)
     VALUES ($1, $2, COALESCE($3, now()), $4)
     RETURNING ${PO_COLUMNS}`,
    [shopId, supplierId, orderedAt ?? null, notes ?? null]
  );
  return rows[0];
}

/**
 * Bulk insert via unnest() - one atomic statement for every line item,
 * rather than N separate INSERTs. Verified empirically (including a NULL
 * unitCost mixed with priced items) before relying on it. This project has
 * no transaction wrapper anywhere (same constraint noted in 7.4), so making
 * the whole line-item write ONE statement is what keeps it atomic without
 * adding transaction infrastructure.
 */
export async function createPurchaseOrderItems(purchaseOrderId, items) {
  const inventoryItemIds = items.map((i) => i.inventoryItemId);
  const quantities = items.map((i) => i.quantity);
  const unitCosts = items.map((i) => i.unitCost ?? null);
  const { rows } = await query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost)
     SELECT $1, unnest($2::uuid[]), unnest($3::numeric[]), unnest($4::numeric[])
     RETURNING id, purchase_order_id, inventory_item_id, quantity, unit_cost, created_at`,
    [purchaseOrderId, inventoryItemIds, quantities, unitCosts]
  );
  return rows;
}

/** Used to validate every referenced item belongs to the shop BEFORE writing anything. */
export async function countExistingItemsForShop(shopId, itemIds) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM inventory_items
     WHERE id = ANY($1::uuid[]) AND shop_id = $2 AND deleted_at IS NULL`,
    [itemIds, shopId]
  );
  return rows[0].count;
}

/**
 * Supplier name joined in for list-view convenience (avoids N+1 lookups
 * from the caller). totalCost sums quantity * unit_cost across line items,
 * SUM() skipping any item with no cost recorded yet rather than nulling
 * the whole total - verified empirically.
 */
export async function listActivePurchaseOrdersForShop(shopId) {
  const { rows } = await query(
    `SELECT po.id, po.shop_id, po.supplier_id, s.name AS supplier_name,
            po.ordered_at, po.notes, po.created_at, po.updated_at,
            COALESCE(SUM(poi.quantity * poi.unit_cost), 0) AS total_cost,
            count(poi.id)::int AS item_count
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE po.shop_id = $1 AND po.deleted_at IS NULL
     GROUP BY po.id, s.name
     ORDER BY po.ordered_at DESC`,
    [shopId]
  );
  return rows;
}

export async function findActivePurchaseOrderByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT po.id, po.shop_id, po.supplier_id, s.name AS supplier_name,
            po.ordered_at, po.notes, po.created_at, po.updated_at
     FROM purchase_orders po
     JOIN suppliers s ON s.id = po.supplier_id
     WHERE po.id = $1 AND po.shop_id = $2 AND po.deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function listItemsForPurchaseOrder(purchaseOrderId) {
  const { rows } = await query(
    `SELECT poi.id, poi.inventory_item_id, ii.name AS item_name, ii.unit,
            poi.quantity, poi.unit_cost, poi.created_at
     FROM purchase_order_items poi
     JOIN inventory_items ii ON ii.id = poi.inventory_item_id
     WHERE poi.purchase_order_id = $1
     ORDER BY ii.name`,
    [purchaseOrderId]
  );
  return rows;
}

export async function softDeletePurchaseOrder(id) {
  await query(`UPDATE purchase_orders SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
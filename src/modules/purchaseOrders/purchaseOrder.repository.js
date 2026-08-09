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

/**
 * Ordered quantity per PO line item, plus cumulative received-so-far
 * (summed across every receipt logged against that line item, correctly
 * 0 via COALESCE if none have been received yet). This is what the service
 * layer computes discrepancy from.
 */
export async function listItemsWithReceivedQuantities(purchaseOrderId) {
  const { rows } = await query(
    `SELECT poi.id, poi.inventory_item_id, ii.name AS item_name, ii.unit,
            poi.quantity AS ordered_quantity, poi.unit_cost, poi.created_at,
            COALESCE(SUM(pori.quantity_received), 0) AS received_quantity
     FROM purchase_order_items poi
     JOIN inventory_items ii ON ii.id = poi.inventory_item_id
     LEFT JOIN purchase_order_receipt_items pori ON pori.purchase_order_item_id = poi.id
     WHERE poi.purchase_order_id = $1
     GROUP BY poi.id, ii.name, ii.unit
     ORDER BY ii.name`,
    [purchaseOrderId]
  );
  return rows;
}

export async function softDeletePurchaseOrder(id) {
  await query(`UPDATE purchase_orders SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

// --- Stock receiving (7.6) ---

const RECEIPT_COLUMNS = `id, purchase_order_id, received_at, notes, created_at, updated_at`;

export async function createReceipt(purchaseOrderId, { receivedAt, notes }) {
  const { rows } = await query(
    `INSERT INTO purchase_order_receipts (purchase_order_id, received_at, notes)
     VALUES ($1, COALESCE($2, now()), $3)
     RETURNING ${RECEIPT_COLUMNS}`,
    [purchaseOrderId, receivedAt ?? null, notes ?? null]
  );
  return rows[0];
}

/** Same bulk-insert-via-unnest() pattern as createPurchaseOrderItems (7.5) - one atomic statement. */
export async function createReceiptItems(receiptId, items) {
  const poItemIds = items.map((i) => i.purchaseOrderItemId);
  const quantities = items.map((i) => i.quantityReceived);
  const { rows } = await query(
    `INSERT INTO purchase_order_receipt_items (purchase_order_receipt_id, purchase_order_item_id, quantity_received)
     SELECT $1, unnest($2::uuid[]), unnest($3::numeric[])
     RETURNING id, purchase_order_receipt_id, purchase_order_item_id, quantity_received, created_at`,
    [receiptId, poItemIds, quantities]
  );
  return rows;
}

/**
 * Fetches the PO items being received (id + inventory_item_id), SCOPED to
 * this specific PO - serves two purposes at once: validating that every
 * referenced purchase_order_item_id actually belongs to this PO (compare
 * the returned row count to poItemIds.length), and resolving each one's
 * underlying inventory_item_id for the stock update, without a second query.
 */
export async function findPoItemsForPurchaseOrder(purchaseOrderId, poItemIds) {
  const { rows } = await query(
    `SELECT id, inventory_item_id FROM purchase_order_items
     WHERE id = ANY($1::uuid[]) AND purchase_order_id = $2`,
    [poItemIds, purchaseOrderId]
  );
  return rows;
}

// Bulk stock adjustment now lives in inventory.repository.js as
// adjustInventoryQuantities - relocated there (7.7) since it's a general
// inventory operation (receiving increments, wastage decrements), not
// something that belongs to the purchase-orders module specifically.

export async function listReceiptsForPurchaseOrder(purchaseOrderId) {
  const { rows } = await query(
    `SELECT ${RECEIPT_COLUMNS} FROM purchase_order_receipts
     WHERE purchase_order_id = $1
     ORDER BY received_at DESC`,
    [purchaseOrderId]
  );
  return rows;
}

/**
 * Every receipt line item across EVERY receipt for this PO, flat (tagged
 * with purchase_order_receipt_id) - same "flat query + group in JS" pattern
 * as 6.4's modifiers, avoiding an N+1 query per receipt.
 */
export async function listAllReceiptItemsForPurchaseOrder(purchaseOrderId) {
  const { rows } = await query(
    `SELECT pori.id, pori.purchase_order_receipt_id, pori.purchase_order_item_id,
            ii.name AS item_name, ii.unit, pori.quantity_received, pori.created_at
     FROM purchase_order_receipt_items pori
     JOIN purchase_order_items poi ON poi.id = pori.purchase_order_item_id
     JOIN inventory_items ii ON ii.id = poi.inventory_item_id
     JOIN purchase_order_receipts por ON por.id = pori.purchase_order_receipt_id
     WHERE por.purchase_order_id = $1
     ORDER BY ii.name`,
    [purchaseOrderId]
  );
  return rows;
}
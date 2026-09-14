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

// The unconditional soft-delete that used to live here was removed rather
// than left unused: it deleted a PO regardless of whether stock had already
// been received against it, so keeping it around would leave a way to bypass
// softDeletePurchaseOrderIfUnreceived below by calling the wrong function.

// --- Stock receiving (7.6) ---

const RECEIPT_COLUMNS = `id, purchase_order_id, received_at, notes, created_at, updated_at`;

/**
 * Creates the receipt header, but ONLY while the PO is still active - and it
 * takes a row lock on that PO while doing so. Returns undefined if the PO has
 * been deleted, which the caller turns into a 404.
 *
 * The `UPDATE purchase_orders` in the CTE is the entire point: it locks the
 * PO row for the duration of this one statement and stamps first_received_at,
 * which is exactly the column softDeletePurchaseOrderIfUnreceived tests. That
 * is what makes receiving and deletion MUTUALLY EXCLUSIVE - both write the
 * same row, so Postgres serialises them and the loser's re-check sees the
 * winner's write. Verified empirically in BOTH orderings.
 *
 * COALESCE keeps the FIRST arrival time, so a second partial delivery never
 * overwrites it.
 *
 * This project has no transaction wrapper anywhere, so serialising on a
 * shared row lock inside one statement is how atomicity is achieved here -
 * the same shape as 10.3's deduction claim.
 */
export async function createReceipt(purchaseOrderId, { receivedAt, notes }) {
  const { rows } = await query(
    `WITH locked_po AS (
       UPDATE purchase_orders
       SET updated_at = now(),
           first_received_at = COALESCE(first_received_at, COALESCE($2, now()))
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id
     )
     INSERT INTO purchase_order_receipts (purchase_order_id, received_at, notes)
     SELECT locked_po.id, COALESCE($2, now()), $3 FROM locked_po
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

/**
 * Soft-deletes a PO ONLY if nothing has ever been received against it, as a
 * single statement so the check and the write cannot be interleaved.
 * Returns undefined when it did not apply - either the PO has receipts, or
 * it was already deleted.
 *
 * The condition is first_received_at on the PO ROW, NOT a subquery over
 * purchase_order_receipts, and that distinction is load-bearing. Verified
 * empirically with two overlapping transactions: with the subquery form the
 * delete blocks on the row lock as expected, but on unblocking READ COMMITTED
 * re-checks the qual against the updated row while the subquery still reads
 * the ORIGINAL snapshot - so a receipt committed in the meantime is invisible
 * and the delete goes through anyway. Testing a column on the same row is
 * re-read correctly, which is why this form holds and that one did not.
 *
 * createReceipt stamps first_received_at in the same statement that inserts
 * the receipt, so the two contend for one row and whichever commits first
 * wins. See the migration for the full reasoning.
 */
export async function softDeletePurchaseOrderIfUnreceived(id) {
  const { rows } = await query(
    `UPDATE purchase_orders
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL AND first_received_at IS NULL
     RETURNING id`,
    [id]
  );
  return rows[0];
}

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
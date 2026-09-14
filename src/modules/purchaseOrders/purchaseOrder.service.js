import { AppError } from '../../utils/AppError.js';
import { requireViewInventory, requireManageInventory } from '../inventory/inventory.service.js';
import * as inventoryRepository from '../inventory/inventory.repository.js';
import * as supplierRepository from '../suppliers/supplier.repository.js';
import * as purchaseOrderRepository from './purchaseOrder.repository.js';

function toItemResponse(item) {
  const orderedQuantity = Number(item.ordered_quantity);
  const receivedQuantity = Number(item.received_quantity);
  const discrepancy = receivedQuantity - orderedQuantity;
  return {
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    itemName: item.item_name,
    unit: item.unit,
    // Renamed from 7.5's plain `quantity` - genuinely clearer now that a
    // separate receivedQuantity exists alongside it; "quantity" alone would
    // be ambiguous between the two.
    orderedQuantity,
    unitCost: item.unit_cost === null ? null : Number(item.unit_cost),
    receivedQuantity,
    // Computed, not stored - same "derive, don't store" philosophy as
    // isBillingLocked (3.6) and 7.3's isLowStock. Deliberately not
    // interpreted as "still pending" vs "final" - a negative discrepancy
    // may just mean more receipts are still expected; the raw numbers are
    // exposed honestly rather than guessing at that.
    discrepancy,
    hasDiscrepancy: discrepancy !== 0,
    createdAt: item.created_at,
  };
}

function toListResponse(po) {
  return {
    id: po.id,
    shopId: po.shop_id,
    supplierId: po.supplier_id,
    supplierName: po.supplier_name,
    orderedAt: po.ordered_at,
    notes: po.notes,
    itemCount: po.item_count,
    totalCost: Number(po.total_cost),
    createdAt: po.created_at,
    updatedAt: po.updated_at,
  };
}

function toReceiptItemResponse(item) {
  return {
    id: item.id,
    purchaseOrderItemId: item.purchase_order_item_id,
    itemName: item.item_name,
    unit: item.unit,
    quantityReceived: Number(item.quantity_received),
    createdAt: item.created_at,
  };
}

function toReceiptResponse(receipt, items) {
  return {
    id: receipt.id,
    receivedAt: receipt.received_at,
    notes: receipt.notes,
    items: items.map(toReceiptItemResponse),
    createdAt: receipt.created_at,
    updatedAt: receipt.updated_at,
  };
}

function toDetailResponse(po, items, receipts, receiptItemsByReceiptId) {
  const mappedItems = items.map(toItemResponse);
  // Computed here from the items already fetched, rather than a second
  // query - same "derive, don't store" philosophy as isBillingLocked
  // (3.6), just computed in JS here since the rows are already in hand.
  // Based on ORDERED quantity, not received - this is what was agreed to
  // pay, independent of how much has actually arrived so far.
  //
  // Settled to 5 decimal places, and 5 is not arbitrary: it is exactly the
  // scale Postgres produces for this same total on the LIST endpoint, which
  // computes it as COALESCE(SUM(poi.quantity * poi.unit_cost), 0) - a
  // numeric(10,3) times a numeric(10,2) is exact at scale 5, and summing
  // those keeps scale 5. Without this rounding the two endpoints can return
  // different numbers for the SAME purchase order: 1.005 x 3.33 is 3.34665
  // out of SQL but 3.3466500000000004 in JS floating point.
  //
  // Deliberately NOT rounded to 2dp. That would look like the natural choice
  // for a money field, but it would make this DISAGREE with the list
  // endpoint (3.35 vs 3.34665) - i.e. it would introduce the very divergence
  // this is here to remove. Rounding to the scale SQL actually yields is
  // what makes the two definitions of totalCost provably identical, the same
  // "one definition of a total" discipline as 9.5's amountPaid and 9.8's
  // vatAmount. Float error is ~1e-10 at realistic PO magnitudes, far below
  // the 5e-6 that could change a 5dp result, so this only ever rounds away
  // representation noise, never real precision.
  const totalCost = Number(
    mappedItems
      .reduce(
        (sum, item) => sum + (item.unitCost === null ? 0 : item.unitCost * item.orderedQuantity),
        0
      )
      .toFixed(5)
  );
  const mappedReceipts = receipts.map((r) =>
    toReceiptResponse(r, receiptItemsByReceiptId.get(r.id) ?? [])
  );
  return {
    id: po.id,
    shopId: po.shop_id,
    supplierId: po.supplier_id,
    supplierName: po.supplier_name,
    orderedAt: po.ordered_at,
    notes: po.notes,
    items: mappedItems,
    receipts: mappedReceipts,
    totalCost,
    createdAt: po.created_at,
    updatedAt: po.updated_at,
  };
}

async function getSupplierForShopOrThrow(shopId, supplierId) {
  const supplier = await supplierRepository.findActiveSupplierByIdForShop(supplierId, shopId);
  if (!supplier) {
    throw new AppError('Supplier not found', 404);
  }
  return supplier;
}

async function getPurchaseOrderOrThrow(shopId, poId) {
  const po = await purchaseOrderRepository.findActivePurchaseOrderByIdForShop(poId, shopId);
  if (!po) {
    throw new AppError('Purchase order not found', 404);
  }
  return po;
}

/**
 * Fetch-and-format only, no permission check - shared by the public
 * getPurchaseOrder AND createPurchaseOrder's/createReceipt's response.
 * Deliberately separate from getPurchaseOrder: if createPurchaseOrder
 * called the public getPurchaseOrder directly, it would re-check
 * VIEW_INVENTORY after already writing the record - an actor with
 * MANAGE_INVENTORY but not VIEW_INVENTORY (a legitimate combination via
 * 4.4's override system) would then get a confusing 403 AFTER the write
 * already succeeded.
 */
async function fetchPurchaseOrderDetail(shopId, poId) {
  const po = await getPurchaseOrderOrThrow(shopId, poId);
  const items = await purchaseOrderRepository.listItemsWithReceivedQuantities(po.id);
  const receipts = await purchaseOrderRepository.listReceiptsForPurchaseOrder(po.id);
  const allReceiptItems = await purchaseOrderRepository.listAllReceiptItemsForPurchaseOrder(po.id);

  // Flat rows grouped by receipt in JS - same "flat query + group in JS"
  // pattern as 6.4's modifiers, rather than an N+1 query per receipt.
  const receiptItemsByReceiptId = new Map();
  for (const item of allReceiptItems) {
    const list = receiptItemsByReceiptId.get(item.purchase_order_receipt_id) ?? [];
    list.push(item);
    receiptItemsByReceiptId.set(item.purchase_order_receipt_id, list);
  }

  return toDetailResponse(po, items, receipts, receiptItemsByReceiptId);
}

/**
 * Validates the supplier and every referenced inventory item belong to the
 * shop BEFORE writing anything, then creates the header and bulk-inserts
 * line items as one atomic statement (see purchaseOrder.repository.js).
 */
export async function createPurchaseOrder(actor, shopId, { supplierId, orderedAt, notes, items }) {
  await requireManageInventory(actor, shopId);
  await getSupplierForShopOrThrow(shopId, supplierId);

  const itemIds = items.map((i) => i.inventoryItemId);
  const existingCount = await purchaseOrderRepository.countExistingItemsForShop(shopId, itemIds);
  if (existingCount !== itemIds.length) {
    throw new AppError('One or more items are not valid inventory items for this shop', 404);
  }

  const created = await purchaseOrderRepository.createPurchaseOrder(shopId, {
    supplierId,
    orderedAt,
    notes,
  });
  await purchaseOrderRepository.createPurchaseOrderItems(created.id, items);

  return fetchPurchaseOrderDetail(shopId, created.id);
}

export async function listPurchaseOrders(actor, shopId) {
  await requireViewInventory(actor, shopId);
  const purchaseOrders = await purchaseOrderRepository.listActivePurchaseOrdersForShop(shopId);
  return purchaseOrders.map(toListResponse);
}

export async function getPurchaseOrder(actor, shopId, poId) {
  await requireViewInventory(actor, shopId);
  return fetchPurchaseOrderDetail(shopId, poId);
}

/**
 * Deleting a PO is only safe while it is still purely a record of INTENT.
 * Once anything has been received against it, receiving has already
 * incremented real stock (createReceipt below is this module's one write
 * path that mutates quantityOnHand), and those receipts are immutable
 * "already-applied state change" records with no soft-delete of their own.
 *
 * Deleting at that point would leave stock on hand with nothing explaining
 * where it came from, and orphan the receipts behind a parent that now 404s -
 * so the receiving history would become invisible while the stock it created
 * stayed. Blocked with a 409, exactly as a menu category that still has items
 * is blocked rather than cascading.
 *
 * Deliberately NOT solved by giving the PO a status: 7.5 established that
 * purchase orders have no workflow/status field, and the receipts themselves
 * are already the record of what actually arrived.
 */
export async function deletePurchaseOrder(actor, shopId, poId) {
  await requireManageInventory(actor, shopId);
  const po = await getPurchaseOrderOrThrow(shopId, poId);

  const receiptCount = await purchaseOrderRepository.countReceiptsForPurchaseOrder(po.id);
  if (receiptCount > 0) {
    throw new AppError(
      'Cannot delete a purchase order that has already been received against - its receipts have already adjusted stock',
      409
    );
  }

  await purchaseOrderRepository.softDeletePurchaseOrder(po.id);
}

// --- Stock receiving (7.6) ---

/**
 * Logs a receiving event against this PO and increments the underlying
 * inventory items' quantityOnHand by what was actually received - the one
 * write path in this module that mutates real stock, confirmed directly.
 * Deliberately allows over/under-delivery (quantityReceived is never
 * capped against what was ordered) - that mismatch is exactly what
 * discrepancy is for surfacing, not something to silently block.
 *
 * Validates every referenced purchase_order_item_id belongs to THIS PO
 * before writing anything (same fail-closed pattern as 7.5's item
 * validation), then: creates the receipt header, bulk-inserts receipt line
 * items as one atomic statement, and bulk-increments every affected
 * inventory item's stock as a second atomic statement - both verified
 * empirically, including that repeated partial receipts against the same
 * item correctly accumulate rather than overwrite.
 */
export async function createReceipt(actor, shopId, poId, { receivedAt, notes, items }) {
  await requireManageInventory(actor, shopId);
  const po = await getPurchaseOrderOrThrow(shopId, poId);

  const poItemIds = items.map((i) => i.purchaseOrderItemId);
  const poItems = await purchaseOrderRepository.findPoItemsForPurchaseOrder(po.id, poItemIds);
  if (poItems.length !== poItemIds.length) {
    throw new AppError('One or more line items do not belong to this purchase order', 404);
  }

  const receipt = await purchaseOrderRepository.createReceipt(po.id, { receivedAt, notes });
  await purchaseOrderRepository.createReceiptItems(receipt.id, items);

  // Resolve each receipt line's underlying inventory_item_id via the
  // already-fetched po items (no second lookup needed), then bulk-increment
  // stock in one statement.
  //
  // LOAD-BEARING INVARIANT, documented here because it is enforced in a
  // DIFFERENT file and is easy to break by accident: the array built below
  // must never contain the same inventory_item_id twice. adjustInventoryQuantities
  // uses UPDATE...FROM unnest(), which - verified empirically in 7.9 -
  // silently applies only ONE delta per duplicated id and drops the rest
  // with no error, i.e. a duplicate here would under-increment stock
  // invisibly.
  //
  // Two separate refines make that impossible today, and BOTH are required:
  //   - createReceiptSchema dedups purchaseOrderItemId within one receipt.
  //   - createPurchaseOrderSchema dedups inventoryItemId within one PO,
  //     so two distinct PO lines can never point at the same stock item.
  // The second one is the non-obvious half: it was written to keep a PO
  // tidy ("each item should appear once, with one quantity"), not for this
  // reason, but relaxing it - e.g. to allow ordering the same item twice at
  // two different unit costs, a perfectly reasonable future request - would
  // silently break receiving here. If that refine is ever loosened, this
  // call must pre-aggregate by inventory_item_id first, exactly as 7.9's
  // deduction engine already does.
  const poItemById = new Map(poItems.map((pi) => [pi.id, pi]));
  const inventoryItemIds = items.map((i) => poItemById.get(i.purchaseOrderItemId).inventory_item_id);
  const amounts = items.map((i) => i.quantityReceived);
  await inventoryRepository.adjustInventoryQuantities(inventoryItemIds, amounts);

  return fetchPurchaseOrderDetail(shopId, po.id);
}
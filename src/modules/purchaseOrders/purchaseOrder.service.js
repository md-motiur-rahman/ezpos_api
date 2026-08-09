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
  const totalCost = mappedItems.reduce(
    (sum, item) => sum + (item.unitCost === null ? 0 : item.unitCost * item.orderedQuantity),
    0
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

export async function deletePurchaseOrder(actor, shopId, poId) {
  await requireManageInventory(actor, shopId);
  const po = await getPurchaseOrderOrThrow(shopId, poId);
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
  const poItemById = new Map(poItems.map((pi) => [pi.id, pi]));
  const inventoryItemIds = items.map((i) => poItemById.get(i.purchaseOrderItemId).inventory_item_id);
  const amounts = items.map((i) => i.quantityReceived);
  await inventoryRepository.adjustInventoryQuantities(inventoryItemIds, amounts);

  return fetchPurchaseOrderDetail(shopId, po.id);
}
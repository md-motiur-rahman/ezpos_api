import { AppError } from '../../utils/AppError.js';
import { requireViewInventory, requireManageInventory } from '../inventory/inventory.service.js';
import * as supplierRepository from '../suppliers/supplier.repository.js';
import * as purchaseOrderRepository from './purchaseOrder.repository.js';

function toItemResponse(item) {
  return {
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    itemName: item.item_name,
    unit: item.unit,
    quantity: Number(item.quantity),
    unitCost: item.unit_cost === null ? null : Number(item.unit_cost),
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

function toDetailResponse(po, items) {
  const mappedItems = items.map(toItemResponse);
  // Computed here from the items already fetched, rather than a second
  // query - same "derive, don't store" philosophy as isBillingLocked
  // (3.6), just computed in JS here since the rows are already in hand.
  const totalCost = mappedItems.reduce(
    (sum, item) => sum + (item.unitCost === null ? 0 : item.unitCost * item.quantity),
    0
  );
  return {
    id: po.id,
    shopId: po.shop_id,
    supplierId: po.supplier_id,
    supplierName: po.supplier_name,
    orderedAt: po.ordered_at,
    notes: po.notes,
    items: mappedItems,
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
 * getPurchaseOrder AND createPurchaseOrder's response. Deliberately
 * separate from getPurchaseOrder: if createPurchaseOrder called the public
 * getPurchaseOrder directly, it would re-check VIEW_INVENTORY after already
 * writing the record - an actor with MANAGE_INVENTORY but not
 * VIEW_INVENTORY (a legitimate combination via 4.4's override system) would
 * then get a confusing 403 AFTER the write already succeeded.
 */
async function fetchPurchaseOrderDetail(shopId, poId) {
  const po = await getPurchaseOrderOrThrow(shopId, poId);
  const items = await purchaseOrderRepository.listItemsForPurchaseOrder(po.id);
  return toDetailResponse(po, items);
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
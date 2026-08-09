import { AppError } from '../../utils/AppError.js';
import { requireViewInventory } from '../inventory/inventory.service.js';
import * as inventoryRepository from '../inventory/inventory.repository.js';
import * as wastageLogRepository from './wastageLog.repository.js';

function toItemResponse(item) {
  return {
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    itemName: item.item_name,
    unit: item.unit,
    quantityWasted: Number(item.quantity_wasted),
    reason: item.reason,
    notes: item.notes,
    createdAt: item.created_at,
  };
}

function toListResponse(log) {
  return {
    id: log.id,
    shopId: log.shop_id,
    wastedAt: log.wasted_at,
    notes: log.notes,
    itemCount: log.item_count,
    createdAt: log.created_at,
    updatedAt: log.updated_at,
  };
}

function toDetailResponse(log, items) {
  return {
    id: log.id,
    shopId: log.shop_id,
    wastedAt: log.wasted_at,
    notes: log.notes,
    items: items.map(toItemResponse),
    createdAt: log.created_at,
    updatedAt: log.updated_at,
  };
}

async function getWastageLogOrThrow(shopId, wastageLogId) {
  const log = await wastageLogRepository.findWastageLogByIdForShop(wastageLogId, shopId);
  if (!log) {
    throw new AppError('Wastage log not found', 404);
  }
  return log;
}

/**
 * Fetch-and-format only, no permission check - shared by the public
 * getWastageLog AND createWastageLog's response. Kept as a separate
 * internal helper (rather than createWastageLog calling the public
 * getWastageLog directly) so a future permission change to either read or
 * write doesn't risk one silently re-checking the other's requirement.
 */
async function fetchWastageLogDetail(shopId, wastageLogId) {
  const log = await getWastageLogOrThrow(shopId, wastageLogId);
  const items = await wastageLogRepository.listItemsForWastageLog(log.id);
  return toDetailResponse(log, items);
}

/**
 * Validates every referenced item belongs to the shop AND has enough
 * quantityOnHand for what's being logged as wasted, BEFORE writing
 * anything (confirmed: wasting more than is on hand is blocked, not
 * allowed to go negative - forces a stock correction via 7.1 first).
 * Then creates the log header, bulk-inserts line items, and atomically
 * decrements stock via inventory.repository.js's shared adjustment
 * function (7.7's refactor) using negative amounts.
 *
 * Requires VIEW_INVENTORY, not MANAGE_INVENTORY - confirmed directly:
 * reading and logging wastage share the same permission gate, so anyone
 * who can see the shop's stock (e.g. a Chef, who has VIEW_INVENTORY by
 * default) can also log wastage against it, not just Managers.
 */
export async function createWastageLog(actor, shopId, { wastedAt, notes, items }) {
  await requireViewInventory(actor, shopId);

  const itemIds = items.map((i) => i.inventoryItemId);
  const inventoryItems = await inventoryRepository.findActiveItemsByIdsForShop(shopId, itemIds);
  if (inventoryItems.length !== itemIds.length) {
    throw new AppError('One or more items are not valid inventory items for this shop', 404);
  }

  const inventoryItemById = new Map(inventoryItems.map((item) => [item.id, item]));
  for (const lineItem of items) {
    const currentItem = inventoryItemById.get(lineItem.inventoryItemId);
    const currentQuantity = Number(currentItem.quantity_on_hand);
    if (lineItem.quantityWasted > currentQuantity) {
      throw new AppError(
        `Cannot waste ${lineItem.quantityWasted} ${currentItem.unit} of "${currentItem.name}" - only ${currentQuantity} ${currentItem.unit} currently on hand`,
        409
      );
    }
  }

  const log = await wastageLogRepository.createWastageLog(shopId, { wastedAt, notes });
  await wastageLogRepository.createWastageLogItems(log.id, items);

  const inventoryItemIds = items.map((i) => i.inventoryItemId);
  const amounts = items.map((i) => -i.quantityWasted); // negative - this is a decrement
  await inventoryRepository.adjustInventoryQuantities(inventoryItemIds, amounts);

  return fetchWastageLogDetail(shopId, log.id);
}

export async function listWastageLogs(actor, shopId) {
  await requireViewInventory(actor, shopId);
  const logs = await wastageLogRepository.listWastageLogsForShop(shopId);
  return logs.map(toListResponse);
}

export async function getWastageLog(actor, shopId, wastageLogId) {
  await requireViewInventory(actor, shopId);
  return fetchWastageLogDetail(shopId, wastageLogId);
}
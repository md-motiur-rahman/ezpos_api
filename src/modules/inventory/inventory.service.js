import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as inventoryRepository from './inventory.repository.js';
import * as supplierRepository from '../suppliers/supplier.repository.js';

/**
 * Unlike Module 6's menu, reads here are NOT open to every in-scope actor -
 * stock levels are back-of-house, which is exactly why VIEW_INVENTORY (4.1)
 * exists as its own grantable permission rather than being universal. A
 * Server has an obvious need to see the menu; they have no equivalent need
 * to see stock counts by default.
 */
async function requireViewInventory(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.VIEW_INVENTORY,
    'You do not have permission to view inventory'
  );
  return authority;
}

async function requireManageInventory(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.MANAGE_INVENTORY,
    'You do not have permission to manage inventory'
  );
  return authority;
}

// Exported for reuse - suppliers (7.4) and the item<->supplier links below
// are inventory-adjacent, back-of-house data using this exact same
// permission pair, same cross-module reuse pattern as shopMenu.service.js
// importing groupModifierRows from menu.service.js (6.4).
export { requireViewInventory, requireManageInventory };

function toResponse(item) {
  const lowStockThreshold =
    item.low_stock_threshold === null ? null : Number(item.low_stock_threshold);
  return {
    id: item.id,
    shopId: item.shop_id,
    name: item.name,
    unit: item.unit,
    quantityOnHand: Number(item.quantity_on_hand),
    lowStockThreshold,
    // Computed, not stored - same "derive, don't store" philosophy as
    // isBillingLocked (3.6). Always correct relative to the current
    // quantityOnHand, no separate sync step needed. An item with no
    // threshold configured is never low stock, regardless of quantity.
    isLowStock: lowStockThreshold !== null && Number(item.quantity_on_hand) <= lowStockThreshold,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export async function createItem(actor, shopId, data) {
  await requireManageInventory(actor, shopId);
  const item = await inventoryRepository.createItem(shopId, data);
  return toResponse(item);
}

export async function listItems(actor, shopId, { lowStockOnly } = {}) {
  await requireViewInventory(actor, shopId);
  const items = await inventoryRepository.listActiveItemsForShop(shopId, {
    lowStockOnly: lowStockOnly === 'true',
  });
  return items.map(toResponse);
}

async function getItemOrThrow(shopId, itemId) {
  const item = await inventoryRepository.findActiveItemByIdForShop(itemId, shopId);
  if (!item) {
    throw new AppError('Inventory item not found', 404);
  }
  return item;
}

export async function getItem(actor, shopId, itemId) {
  await requireViewInventory(actor, shopId);
  const item = await getItemOrThrow(shopId, itemId);
  return toResponse(item);
}

export async function updateItem(actor, shopId, itemId, data) {
  await requireManageInventory(actor, shopId);
  await getItemOrThrow(shopId, itemId);

  const updated = await inventoryRepository.updateItem(itemId, data);
  return toResponse(updated);
}

export async function deleteItem(actor, shopId, itemId) {
  await requireManageInventory(actor, shopId);
  const item = await getItemOrThrow(shopId, itemId);
  await inventoryRepository.softDeleteItem(item.id);
}

// --- Item <-> supplier linking (7.4) ---

const POSTGRES_UNIQUE_VIOLATION = '23505';

function toItemSupplierResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSupplierForShopOrThrow(shopId, supplierId) {
  const supplier = await supplierRepository.findActiveSupplierByIdForShop(supplierId, shopId);
  if (!supplier) {
    throw new AppError('Supplier not found', 404);
  }
  return supplier;
}

export async function attachSupplierToItem(actor, shopId, itemId, supplierId, isDefault) {
  await requireManageInventory(actor, shopId);
  await getItemOrThrow(shopId, itemId);
  await getSupplierForShopOrThrow(shopId, supplierId);

  try {
    await inventoryRepository.attachSupplierToItem(itemId, supplierId, isDefault);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This supplier is already linked to this item', 409);
    }
    throw err;
  }
}

/**
 * The "editable" half of the link - lets isDefault be flipped later without
 * detaching and reattaching, exactly the "chicken breast defaults to
 * Bidfood but can also come from Brakes" case confirmed directly: switching
 * the default is PATCHing the Brakes link to isDefault: true, not touching
 * either attachment itself.
 */
export async function updateItemSupplierDefault(actor, shopId, itemId, supplierId, isDefault) {
  await requireManageInventory(actor, shopId);
  await getItemOrThrow(shopId, itemId);
  await getSupplierForShopOrThrow(shopId, supplierId);

  const updated = isDefault
    ? await inventoryRepository.setSupplierAsDefaultForItem(itemId, supplierId)
    : await inventoryRepository.unsetSupplierAsDefaultForItem(itemId, supplierId);

  if (!updated) {
    throw new AppError('This supplier is not linked to this item', 404);
  }
}

export async function detachSupplierFromItem(actor, shopId, itemId, supplierId) {
  await requireManageInventory(actor, shopId);
  await getItemOrThrow(shopId, itemId);
  await getSupplierForShopOrThrow(shopId, supplierId);

  const detached = await inventoryRepository.detachSupplierFromItem(itemId, supplierId);
  if (!detached) {
    throw new AppError('This supplier is not linked to this item', 404);
  }
}

export async function listItemSuppliers(actor, shopId, itemId) {
  await requireViewInventory(actor, shopId);
  await getItemOrThrow(shopId, itemId);

  const suppliers = await inventoryRepository.listSuppliersForItem(itemId);
  return suppliers.map(toItemSupplierResponse);
}
import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as inventoryRepository from './inventory.repository.js';

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

function toResponse(item) {
  return {
    id: item.id,
    shopId: item.shop_id,
    name: item.name,
    unit: item.unit,
    quantityOnHand: Number(item.quantity_on_hand),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export async function createItem(actor, shopId, data) {
  await requireManageInventory(actor, shopId);
  const item = await inventoryRepository.createItem(shopId, data);
  return toResponse(item);
}

export async function listItems(actor, shopId) {
  await requireViewInventory(actor, shopId);
  const items = await inventoryRepository.listActiveItemsForShop(shopId);
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
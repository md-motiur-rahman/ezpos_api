import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopRepository from '../shop/shop.repository.js';
import * as menuRepository from './menu.repository.js';
import * as shopMenuRepository from './shopMenu.repository.js';

const MANAGE_MENU_MESSAGE = "You do not have permission to manage this shop's menu";

function toResolvedItem(row, variants) {
  return {
    id: row.id,
    source: 'master',
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: Number(row.effective_price),
    masterPrice: Number(row.master_price),
    isEnabled: row.is_enabled,
    displayOrder: row.display_order,
    variants,
  };
}

function toLocalItemAsResolved(row) {
  return {
    id: row.id,
    source: 'local',
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    masterPrice: null,
    isEnabled: true, // local items have no override concept - they're this shop's own, always on
    displayOrder: row.display_order,
    variants: [], // variants are a master-item-only concept for now
  };
}

function toLocalItemResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: Number(row.price),
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOverrideResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    menuItemId: row.menu_item_id,
    isEnabled: row.is_enabled,
    priceOverride: row.price_override === null ? null : Number(row.price_override),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toResolvedVariant(row) {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.effective_price),
    masterPrice: Number(row.master_price),
    isEnabled: row.is_enabled,
    displayOrder: row.display_order,
  };
}

function toVariantOverrideResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    variantId: row.variant_id,
    isEnabled: row.is_enabled,
    priceOverride: row.price_override === null ? null : Number(row.price_override),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Resolves actor authority (scope check, 404 if none) and fetches the shop
 * itself in one step - every operation here needs both the actor's
 * role/overrides AND the shop's company_id, since 6.1's item/category
 * lookups are company-scoped, not shop-scoped.
 */
async function requireShopContext(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  const shop = await shopRepository.findActiveShopById(shopId);
  if (!shop) {
    throw new AppError('Shop not found', 404);
  }
  return { authority, shop };
}

/**
 * The resolved, ready-to-use menu: every master item (override applied if
 * one exists, else master defaults) plus every shop-local item, each tagged
 * with `source`. This is what Module 9 (till) will eventually consume.
 * Read access stays open to any in-scope actor - same "reads stay open"
 * principle as 5.1/5.2/5.3, since a Server has an obvious need to see the
 * live menu.
 */
export async function getResolvedMenu(actor, shopId) {
  const { shop } = await requireShopContext(actor, shopId);

  const masterRows = await shopMenuRepository.listResolvedMasterItemsForShop(shopId, shop.company_id);
  const localRows = await shopMenuRepository.listActiveLocalItemsForShop(shopId);
  const variantRows = await shopMenuRepository.listResolvedVariantsForShop(shopId, shop.company_id);

  // Group flat variant rows onto their parent item - response-shaping, done
  // here rather than in the repository, which just fetches data.
  const variantsByItemId = new Map();
  for (const row of variantRows) {
    const list = variantsByItemId.get(row.menu_item_id) ?? [];
    list.push(toResolvedVariant(row));
    variantsByItemId.set(row.menu_item_id, list);
  }

  const resolvedMasterItems = masterRows.map((row) =>
    toResolvedItem(row, variantsByItemId.get(row.id) ?? [])
  );

  return [...resolvedMasterItems, ...localRows.map(toLocalItemAsResolved)];
}

/**
 * Confirms the target menu item is real and belongs to THIS shop's company
 * before allowing an override to be set - reuses 6.1's existing lookup
 * rather than a new one, since "is this a real item of mine" is exactly
 * what findActiveItemByIdForCompany already answers.
 */
export async function setOverride(actor, shopId, menuItemId, data) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const masterItem = await menuRepository.findActiveItemByIdForCompany(menuItemId, shop.company_id);
  if (!masterItem) {
    throw new AppError('Menu item not found', 404);
  }

  const override = await shopMenuRepository.upsertOverride(shopId, menuItemId, data);
  return toOverrideResponse(override);
}

export async function clearOverride(actor, shopId, menuItemId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const masterItem = await menuRepository.findActiveItemByIdForCompany(menuItemId, shop.company_id);
  if (!masterItem) {
    throw new AppError('Menu item not found', 404);
  }

  await shopMenuRepository.deleteOverride(shopId, menuItemId);
}

// --- Variant overrides (6.3) ---

/**
 * Same shape as setOverride/clearOverride above, one level down - reuses
 * menuRepository's variant lookup (company-scoped) the same way item
 * overrides reuse the item lookup.
 */
export async function setVariantOverride(actor, shopId, variantId, data) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const variant = await menuRepository.findActiveVariantByIdForCompany(variantId, shop.company_id);
  if (!variant) {
    throw new AppError('Variant not found', 404);
  }

  const override = await shopMenuRepository.upsertVariantOverride(shopId, variantId, data);
  return toVariantOverrideResponse(override);
}

export async function clearVariantOverride(actor, shopId, variantId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const variant = await menuRepository.findActiveVariantByIdForCompany(variantId, shop.company_id);
  if (!variant) {
    throw new AppError('Variant not found', 404);
  }

  await shopMenuRepository.deleteVariantOverride(shopId, variantId);
}

// --- Local (shop-exclusive) items ---

export async function createLocalItem(actor, shopId, { categoryId, name, description, price, displayOrder }) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  // The category still has to be one of the company's real categories - a
  // local item still needs to show up under "Mains" like everything else.
  const category = await menuRepository.findActiveCategoryByIdForCompany(categoryId, shop.company_id);
  if (!category) {
    throw new AppError('Category not found', 404);
  }

  const item = await shopMenuRepository.createLocalItem(shopId, {
    categoryId,
    name,
    description,
    price,
    displayOrder,
  });
  return toLocalItemResponse(item);
}

export async function listLocalItems(actor, shopId) {
  await requireShopContext(actor, shopId); // scope check only - reads stay open
  const items = await shopMenuRepository.listActiveLocalItemsForShop(shopId);
  return items.map(toLocalItemResponse);
}

async function getLocalItemOrThrow(shopId, itemId) {
  const item = await shopMenuRepository.findActiveLocalItemByIdForShop(itemId, shopId);
  if (!item) {
    throw new AppError('Local menu item not found', 404);
  }
  return item;
}

export async function getLocalItem(actor, shopId, itemId) {
  await requireShopContext(actor, shopId);
  const item = await getLocalItemOrThrow(shopId, itemId);
  return toLocalItemResponse(item);
}

export async function updateLocalItem(actor, shopId, itemId, data) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);
  await getLocalItemOrThrow(shopId, itemId);

  if (data.categoryId) {
    const category = await menuRepository.findActiveCategoryByIdForCompany(
      data.categoryId,
      shop.company_id
    );
    if (!category) {
      throw new AppError('Category not found', 404);
    }
  }

  const updated = await shopMenuRepository.updateLocalItem(itemId, data);
  return toLocalItemResponse(updated);
}

export async function deleteLocalItem(actor, shopId, itemId) {
  const { authority } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const item = await getLocalItemOrThrow(shopId, itemId);
  await shopMenuRepository.softDeleteLocalItem(item.id);
}
import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopRepository from '../shop/shop.repository.js';
import * as menuRepository from './menu.repository.js';
import { groupModifierRows } from './menu.service.js';
import * as shopMenuRepository from './shopMenu.repository.js';

const MANAGE_MENU_MESSAGE = "You do not have permission to manage this shop's menu";

/**
 * What a shop's menu shows for an item: the allergens set on the dish itself
 * plus any carried in by ingredients in its recipe, each listed once.
 */
function mergeAllergens(own, fromIngredients) {
  return [...new Set([...(own ?? []), ...(fromIngredients ?? [])])].sort();
}

function toResolvedItem(row, variants, modifierGroups, allergens) {
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
    modifierGroups,
    allergens,
  };
}

function toLocalItemAsResolved(row, variants, modifierGroups, allergens) {
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
    variants,
    modifierGroups,
    allergens,
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
    allergens: row.allergens,
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

function toLocalVariantResponse(row) {
  return {
    id: row.id,
    shopMenuItemId: row.shop_menu_item_id,
    name: row.name,
    price: Number(row.price),
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A shop item's size in the resolved-menu shape (no master to override, so both prices are its own). */
function toLocalVariantAsResolved(row) {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.price),
    masterPrice: Number(row.price),
    isEnabled: true,
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

function toModifierOptionOverrideResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    modifierOptionId: row.modifier_option_id,
    isEnabled: row.is_enabled,
    priceDeltaOverride: row.price_delta_override === null ? null : Number(row.price_delta_override),
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

function toCategoryLabelResponse(category) {
  return {
    id: category.id,
    name: category.name,
    displayOrder: category.display_order,
  };
}

/**
 * Category **names** for the resolved menu's bare `categoryId` (Module
 * 13/14, till category tiles) — deliberately a narrow `{ id, name,
 * displayOrder }` shape, not the owner's full `menu.service.js`
 * `toCategoryResponse` (`companyId`/`isActive`/timestamps are management
 * concerns, not something a till needs to render a tile).
 *
 * Added specifically because `GET /api/companies/mine/menu-categories`
 * (the only other place a category's name is readable) sits behind the
 * owner-only `requireAuth` — confirmed directly, no staff-reachable route
 * returned a category name anywhere before this. The resolved menu
 * (`getResolvedMenu` above) already gives every item's bare `categoryId`;
 * without this, a staff actor building an order has a UUID and nothing to
 * label it with. Reuses `menu.repository.js`'s existing
 * `listActiveCategoriesForCompany` as-is (the identical query the owner's
 * own list endpoint already runs) rather than a second implementation —
 * same company-scoped, non-deleted set either endpoint would return.
 */
export async function listCategoriesForShop(actor, shopId) {
  const { shop } = await requireShopContext(actor, shopId);
  const categories = await menuRepository.listActiveCategoriesForCompany(shop.company_id);
  return categories.map(toCategoryLabelResponse);
}

/**
 * The resolved, ready-to-use menu: every master item (override applied if
 * one exists, else master defaults) plus every shop-local item, each tagged
 * with `source`. This is what Module 9 (till) will eventually consume.
 * Read access stays open to any in-scope actor.
 */
export async function getResolvedMenu(actor, shopId) {
  const { shop } = await requireShopContext(actor, shopId);

  const masterRows = await shopMenuRepository.listResolvedMasterItemsForShop(shopId, shop.company_id);
  const localRows = await shopMenuRepository.listActiveLocalItemsForShop(shopId);
  const variantRows = await shopMenuRepository.listResolvedVariantsForShop(shopId, shop.company_id);
  const masterModifierRows = await shopMenuRepository.listResolvedModifierGroupsForMasterItems(
    shopId,
    shop.company_id
  );
  const localModifierRows = await shopMenuRepository.listResolvedModifierGroupsForLocalItems(shopId);
  const masterAllergenRows = await shopMenuRepository.listAggregatedAllergensForMasterItems(
    shop.company_id
  );
  const localAllergenRows = await shopMenuRepository.listAggregatedAllergensForLocalItems(shopId);
  const localVariantRows = await shopMenuRepository.listLocalVariantsForShop(shopId);
  const localVariantsByItemId = new Map();
  for (const row of localVariantRows) {
    const list = localVariantsByItemId.get(row.shop_menu_item_id) ?? [];
    list.push(toLocalVariantAsResolved(row));
    localVariantsByItemId.set(row.shop_menu_item_id, list);
  }

  // Group flat variant rows onto their parent item - response-shaping, done
  // here rather than in the repository, which just fetches data.
  const variantsByItemId = new Map();
  for (const row of variantRows) {
    const list = variantsByItemId.get(row.menu_item_id) ?? [];
    list.push(toResolvedVariant(row));
    variantsByItemId.set(row.menu_item_id, list);
  }

  // groupModifierRows is shared with menu.service.js's single-item
  // management view (listItemModifierGroups) - same grouping algorithm,
  // reused here for the whole-menu case rather than reimplemented.
  const masterModifiersByItemId = groupModifierRows(masterModifierRows);
  const localModifiersByItemId = groupModifierRows(localModifierRows);

  // Allergens are already aggregated (unioned+deduped) by Postgres itself -
  // just a flat Map here, no JS-side grouping needed, unlike modifiers.
  const masterAllergensByItemId = new Map(
    masterAllergenRows.map((row) => [row.item_id, row.allergens])
  );
  const localAllergensByItemId = new Map(localAllergenRows.map((row) => [row.item_id, row.allergens]));

  const resolvedMasterItems = masterRows.map((row) =>
    toResolvedItem(
      row,
      variantsByItemId.get(row.id) ?? [],
      masterModifiersByItemId.get(row.id) ?? [],
      mergeAllergens(row.own_allergens, masterAllergensByItemId.get(row.id))
    )
  );
  const resolvedLocalItems = localRows.map((row) =>
    toLocalItemAsResolved(
      row,
      localVariantsByItemId.get(row.id) ?? [],
      localModifiersByItemId.get(row.id) ?? [],
      mergeAllergens(row.allergens, localAllergensByItemId.get(row.id))
    )
  );

  return [...resolvedMasterItems, ...resolvedLocalItems];
}

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

export async function createLocalItem(
  actor,
  shopId,
  { categoryId, name, description, price, displayOrder, allergens }
) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

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
    allergens,
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

// --- Modifier option overrides (6.4) ---

export async function setModifierOptionOverride(actor, shopId, optionId, data) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const option = await menuRepository.findActiveOptionByIdForCompany(optionId, shop.company_id);
  if (!option) {
    throw new AppError('Modifier option not found', 404);
  }

  const override = await shopMenuRepository.upsertModifierOptionOverride(shopId, optionId, data);
  return toModifierOptionOverrideResponse(override);
}

export async function clearModifierOptionOverride(actor, shopId, optionId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  const option = await menuRepository.findActiveOptionByIdForCompany(optionId, shop.company_id);
  if (!option) {
    throw new AppError('Modifier option not found', 404);
  }

  await shopMenuRepository.deleteModifierOptionOverride(shopId, optionId);
}

// --- Attaching modifier groups to LOCAL items (6.4) ---

const POSTGRES_UNIQUE_VIOLATION = '23505';

export async function attachModifierGroupToLocalItem(actor, shopId, itemId, groupId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  const group = await menuRepository.findActiveModifierGroupByIdForCompany(groupId, shop.company_id);
  if (!group) {
    throw new AppError('Modifier group not found', 404);
  }

  try {
    await shopMenuRepository.attachModifierGroupToLocalItem(itemId, groupId);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This modifier group is already attached to this item', 409);
    }
    throw err;
  }
}

export async function detachModifierGroupFromLocalItem(actor, shopId, itemId, groupId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  const group = await menuRepository.findActiveModifierGroupByIdForCompany(groupId, shop.company_id);
  if (!group) {
    throw new AppError('Modifier group not found', 404);
  }

  const detached = await shopMenuRepository.detachModifierGroupFromLocalItem(itemId, groupId);
  if (!detached) {
    throw new AppError('This modifier group is not attached to this item', 404);
  }
}

// --- Ingredients / allergens (6.5, extended by 7.2) ---

function toLocalRecipeIngredientResponse(row) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    unit: row.unit,
    allergens: row.allergens,
    quantity: Number(row.quantity),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Sizes on shop-only items ---

export async function createLocalVariant(actor, shopId, itemId, data) {
  const { authority } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);
  await getLocalItemOrThrow(shopId, itemId);
  const variant = await shopMenuRepository.createLocalVariant(itemId, data);
  return toLocalVariantResponse(variant);
}

export async function listLocalVariants(actor, shopId, itemId) {
  await requireShopContext(actor, shopId); // reads stay open to anyone in scope, like the menu itself
  await getLocalItemOrThrow(shopId, itemId);
  const variants = await shopMenuRepository.listActiveVariantsForLocalItem(itemId);
  return variants.map(toLocalVariantResponse);
}

async function getLocalVariantOrThrow(itemId, variantId) {
  const variant = await shopMenuRepository.findActiveVariantByIdForLocalItem(variantId, itemId);
  if (!variant) {
    throw new AppError('Variant not found', 404);
  }
  return variant;
}

export async function updateLocalVariant(actor, shopId, itemId, variantId, data) {
  const { authority } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);
  await getLocalItemOrThrow(shopId, itemId);
  await getLocalVariantOrThrow(itemId, variantId);
  const updated = await shopMenuRepository.updateLocalVariant(variantId, data);
  return toLocalVariantResponse(updated);
}

export async function deleteLocalVariant(actor, shopId, itemId, variantId) {
  const { authority } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);
  await getLocalItemOrThrow(shopId, itemId);
  const variant = await getLocalVariantOrThrow(itemId, variantId);
  await shopMenuRepository.softDeleteLocalVariant(variant.id);
}

// --- A shop item's size's own recipe ---
//
// Same as a master size's recipe: what this size uses ON TOP of the item's
// own recipe. The sale deduction adds the two together.

async function requireLocalVariantAndIngredient(actor, shopId, itemId, variantId, ingredientId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  await getLocalVariantOrThrow(itemId, variantId);
  const ingredient = await menuRepository.findActiveIngredientByIdForCompany(
    ingredientId,
    shop.company_id
  );
  if (!ingredient) {
    throw new AppError('Ingredient not found', 404);
  }
}

export async function attachIngredientToLocalVariant(
  actor,
  shopId,
  itemId,
  variantId,
  ingredientId,
  quantity
) {
  await requireLocalVariantAndIngredient(actor, shopId, itemId, variantId, ingredientId);
  try {
    await menuRepository.attachIngredientToVariant(variantId, ingredientId, quantity);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This ingredient is already attached to this variant', 409);
    }
    throw err;
  }
}

export async function listLocalVariantIngredients(actor, shopId, itemId, variantId) {
  await requireShopContext(actor, shopId); // scope check only - reads stay open
  await getLocalItemOrThrow(shopId, itemId);
  await getLocalVariantOrThrow(itemId, variantId);
  const ingredients = await menuRepository.listAttachedIngredientsForVariant(variantId);
  return ingredients.map(toLocalRecipeIngredientResponse);
}

export async function updateLocalVariantIngredientQuantity(
  actor,
  shopId,
  itemId,
  variantId,
  ingredientId,
  quantity
) {
  await requireLocalVariantAndIngredient(actor, shopId, itemId, variantId, ingredientId);
  const updated = await menuRepository.updateVariantIngredientQuantity(
    variantId,
    ingredientId,
    quantity
  );
  if (!updated) {
    throw new AppError('This ingredient is not attached to this variant', 404);
  }
}

export async function detachIngredientFromLocalVariant(
  actor,
  shopId,
  itemId,
  variantId,
  ingredientId
) {
  await requireLocalVariantAndIngredient(actor, shopId, itemId, variantId, ingredientId);
  const detached = await menuRepository.detachIngredientFromVariant(variantId, ingredientId);
  if (!detached) {
    throw new AppError('This ingredient is not attached to this variant', 404);
  }
}

export async function attachIngredientToLocalItem(actor, shopId, itemId, ingredientId, quantity) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  const ingredient = await menuRepository.findActiveIngredientByIdForCompany(
    ingredientId,
    shop.company_id
  );
  if (!ingredient) {
    throw new AppError('Ingredient not found', 404);
  }

  try {
    await shopMenuRepository.attachIngredientToLocalItem(itemId, ingredientId, quantity);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This ingredient is already attached to this item', 409);
    }
    throw err;
  }
}

export async function updateLocalItemIngredientQuantity(actor, shopId, itemId, ingredientId, quantity) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  const ingredient = await menuRepository.findActiveIngredientByIdForCompany(
    ingredientId,
    shop.company_id
  );
  if (!ingredient) {
    throw new AppError('Ingredient not found', 404);
  }

  const updated = await shopMenuRepository.updateLocalItemIngredientQuantity(
    itemId,
    ingredientId,
    quantity
  );
  if (!updated) {
    throw new AppError('This ingredient is not attached to this item', 404);
  }
}

export async function detachIngredientFromLocalItem(actor, shopId, itemId, ingredientId) {
  const { authority, shop } = await requireShopContext(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_MENU, MANAGE_MENU_MESSAGE);

  await getLocalItemOrThrow(shopId, itemId);
  const ingredient = await menuRepository.findActiveIngredientByIdForCompany(
    ingredientId,
    shop.company_id
  );
  if (!ingredient) {
    throw new AppError('Ingredient not found', 404);
  }

  const detached = await shopMenuRepository.detachIngredientFromLocalItem(itemId, ingredientId);
  if (!detached) {
    throw new AppError('This ingredient is not attached to this item', 404);
  }
}

export async function listLocalItemIngredients(actor, shopId, itemId) {
  await requireShopContext(actor, shopId); // scope check only - reads stay open
  await getLocalItemOrThrow(shopId, itemId);

  const ingredients = await shopMenuRepository.listAttachedIngredientsForLocalItem(itemId);
  return ingredients.map(toLocalRecipeIngredientResponse);
}
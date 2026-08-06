import { AppError } from '../../utils/AppError.js';
import { getActiveCompanyOrThrow } from '../company/company.service.js';
import * as menuRepository from './menu.repository.js';

function toCategoryResponse(category) {
  return {
    id: category.id,
    companyId: category.company_id,
    name: category.name,
    displayOrder: category.display_order,
    isActive: category.is_active,
    createdAt: category.created_at,
    updatedAt: category.updated_at,
  };
}

function toItemResponse(item) {
  return {
    id: item.id,
    categoryId: item.category_id,
    name: item.name,
    description: item.description,
    // pg returns NUMERIC columns as strings - convert to a real number,
    // same pattern as shops.default_vat_rate.
    price: Number(item.price),
    displayOrder: item.display_order,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

// --- Categories ---

export async function createCategory(ownerUserId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const category = await menuRepository.createCategory(company.id, data);
  return toCategoryResponse(category);
}

export async function listCategories(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const categories = await menuRepository.listActiveCategoriesForCompany(company.id);
  return categories.map(toCategoryResponse);
}

async function getCategoryOrThrow(companyId, categoryId) {
  const category = await menuRepository.findActiveCategoryByIdForCompany(categoryId, companyId);
  if (!category) {
    throw new AppError('Category not found', 404);
  }
  return category;
}

export async function updateCategory(ownerUserId, categoryId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getCategoryOrThrow(company.id, categoryId);
  const updated = await menuRepository.updateCategory(categoryId, data);
  return toCategoryResponse(updated);
}

/**
 * A category with any items (active or not toggled - just not soft-deleted)
 * cannot be deleted at all - toggle it inactive instead via the normal PATCH
 * (isActive: false). Only once every item under it has actually been
 * deleted can the category itself be deleted.
 */
export async function deleteCategory(ownerUserId, categoryId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getCategoryOrThrow(company.id, categoryId);

  const itemCount = await menuRepository.countActiveItemsInCategory(categoryId);
  if (itemCount > 0) {
    throw new AppError(
      'Cannot delete a category that still has menu items - remove all items first, or set isActive to false instead',
      409
    );
  }

  await menuRepository.softDeleteCategory(categoryId);
}

// --- Items ---

export async function createItem(ownerUserId, { categoryId, name, description, price, displayOrder }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getCategoryOrThrow(company.id, categoryId); // confirms the category is real and this owner's

  const item = await menuRepository.createItem(categoryId, { name, description, price, displayOrder });
  return toItemResponse(item);
}

export async function listItems(ownerUserId, { categoryId }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);

  // If a categoryId filter was given, confirm it's real and this owner's
  // before using it - an invalid/foreign categoryId should 404, not
  // silently return an empty list.
  if (categoryId) {
    await getCategoryOrThrow(company.id, categoryId);
  }

  const items = await menuRepository.listActiveItemsForCompany(company.id, categoryId);
  return items.map(toItemResponse);
}

async function getItemOrThrow(companyId, itemId) {
  const item = await menuRepository.findActiveItemByIdForCompany(itemId, companyId);
  if (!item) {
    throw new AppError('Menu item not found', 404);
  }
  return item;
}

export async function getItem(ownerUserId, itemId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const item = await getItemOrThrow(company.id, itemId);
  return toItemResponse(item);
}

export async function updateItem(ownerUserId, itemId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);

  // Moving an item to a different category - confirm the new one is real
  // and this owner's too, same reasoning as create.
  if (data.categoryId) {
    await getCategoryOrThrow(company.id, data.categoryId);
  }

  const updated = await menuRepository.updateItem(itemId, data);
  return toItemResponse(updated);
}

export async function deleteItem(ownerUserId, itemId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const item = await getItemOrThrow(company.id, itemId);
  await menuRepository.softDeleteItem(item.id);
}

// --- Variants (6.3) ---

function toVariantResponse(variant) {
  return {
    id: variant.id,
    menuItemId: variant.menu_item_id,
    name: variant.name,
    price: Number(variant.price),
    displayOrder: variant.display_order,
    createdAt: variant.created_at,
    updatedAt: variant.updated_at,
  };
}

export async function createVariant(ownerUserId, itemId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId); // confirms the item is real and this owner's

  const variant = await menuRepository.createVariant(itemId, data);
  return toVariantResponse(variant);
}

export async function listVariants(ownerUserId, itemId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);

  const variants = await menuRepository.listActiveVariantsForItem(itemId);
  return variants.map(toVariantResponse);
}

async function getVariantOrThrow(itemId, variantId) {
  const variant = await menuRepository.findActiveVariantByIdForItem(variantId, itemId);
  if (!variant) {
    throw new AppError('Variant not found', 404);
  }
  return variant;
}

export async function updateVariant(ownerUserId, itemId, variantId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  await getVariantOrThrow(itemId, variantId);

  const updated = await menuRepository.updateVariant(variantId, data);
  return toVariantResponse(updated);
}

export async function deleteVariant(ownerUserId, itemId, variantId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  const variant = await getVariantOrThrow(itemId, variantId);

  await menuRepository.softDeleteVariant(variant.id);
}

// --- Modifiers (6.4) ---

function toModifierGroupResponse(group) {
  return {
    id: group.id,
    companyId: group.company_id,
    name: group.name,
    minSelections: group.min_selections,
    maxSelections: group.max_selections,
    createdAt: group.created_at,
    updatedAt: group.updated_at,
  };
}

function toModifierOptionResponse(option) {
  return {
    id: option.id,
    modifierGroupId: option.modifier_group_id,
    name: option.name,
    priceDelta: Number(option.price_delta),
    displayOrder: option.display_order,
    createdAt: option.created_at,
    updatedAt: option.updated_at,
  };
}

export async function createModifierGroup(ownerUserId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const group = await menuRepository.createModifierGroup(company.id, data);
  return toModifierGroupResponse(group);
}

export async function listModifierGroups(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const groups = await menuRepository.listActiveModifierGroupsForCompany(company.id);
  return groups.map(toModifierGroupResponse);
}

async function getModifierGroupOrThrow(companyId, groupId) {
  const group = await menuRepository.findActiveModifierGroupByIdForCompany(groupId, companyId);
  if (!group) {
    throw new AppError('Modifier group not found', 404);
  }
  return group;
}

export async function updateModifierGroup(ownerUserId, groupId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);
  const updated = await menuRepository.updateModifierGroup(groupId, data);
  return toModifierGroupResponse(updated);
}

/** A group with any (non-deleted) options cannot be deleted - remove options first, same rule as categories (6.1). */
export async function deleteModifierGroup(ownerUserId, groupId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);

  const optionCount = await menuRepository.countActiveOptionsInGroup(groupId);
  if (optionCount > 0) {
    throw new AppError('Cannot delete a modifier group that still has options - remove all options first', 409);
  }

  await menuRepository.softDeleteModifierGroup(groupId);
}

export async function createModifierOption(ownerUserId, groupId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);

  const option = await menuRepository.createModifierOption(groupId, data);
  return toModifierOptionResponse(option);
}

export async function listModifierOptions(ownerUserId, groupId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);

  const options = await menuRepository.listActiveOptionsForGroup(groupId);
  return options.map(toModifierOptionResponse);
}

async function getModifierOptionOrThrow(groupId, optionId) {
  const option = await menuRepository.findActiveOptionByIdForGroup(optionId, groupId);
  if (!option) {
    throw new AppError('Modifier option not found', 404);
  }
  return option;
}

export async function updateModifierOption(ownerUserId, groupId, optionId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);
  await getModifierOptionOrThrow(groupId, optionId);

  const updated = await menuRepository.updateModifierOption(optionId, data);
  return toModifierOptionResponse(updated);
}

export async function deleteModifierOption(ownerUserId, groupId, optionId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getModifierGroupOrThrow(company.id, groupId);
  const option = await getModifierOptionOrThrow(groupId, optionId);

  await menuRepository.softDeleteModifierOption(option.id);
}

// --- Attaching modifier groups to MASTER items ---

const POSTGRES_UNIQUE_VIOLATION = '23505';

export async function attachModifierGroupToItem(ownerUserId, itemId, groupId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  await getModifierGroupOrThrow(company.id, groupId);

  try {
    await menuRepository.attachModifierGroupToItem(itemId, groupId);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This modifier group is already attached to this item', 409);
    }
    throw err;
  }
}

export async function detachModifierGroupFromItem(ownerUserId, itemId, groupId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  await getModifierGroupOrThrow(company.id, groupId);

  const detached = await menuRepository.detachModifierGroupFromItem(itemId, groupId);
  if (!detached) {
    throw new AppError('This modifier group is not attached to this item', 404);
  }
}

export async function listItemModifierGroups(ownerUserId, itemId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);

  const rows = await menuRepository.listAttachedModifierGroupsForItem(itemId);
  return groupModifierRows(rows).get(itemId) ?? [];
}

/**
 * Shared by BOTH master and local item modifier resolution (used again in
 * shopMenu.service.js) - one grouping algorithm, three call sites (master
 * resolved menu, local resolved menu, and this single-item management
 * view), since all three repository queries return identically-shaped flat
 * rows. Exported so shopMenu.service.js reuses this exact function rather
 * than reimplementing the same two-level grouping a second time.
 */
export function groupModifierRows(rows) {
  const groupsByItemId = new Map();
  for (const row of rows) {
    let itemGroups = groupsByItemId.get(row.item_id);
    if (!itemGroups) {
      itemGroups = new Map();
      groupsByItemId.set(row.item_id, itemGroups);
    }
    let group = itemGroups.get(row.group_id);
    if (!group) {
      group = {
        id: row.group_id,
        name: row.group_name,
        minSelections: row.min_selections,
        maxSelections: row.max_selections,
        options: [],
      };
      itemGroups.set(row.group_id, group);
    }
    group.options.push({
      id: row.option_id,
      name: row.option_name,
      price: Number(row.effective_price_delta),
      masterPriceDelta: Number(row.master_price_delta),
      isEnabled: row.is_enabled,
    });
  }

  const result = new Map();
  for (const [itemId, itemGroupsMap] of groupsByItemId) {
    result.set(itemId, Array.from(itemGroupsMap.values()));
  }
  return result;
}

// --- Ingredients / allergens (6.5) ---

function toIngredientResponse(ingredient) {
  return {
    id: ingredient.id,
    companyId: ingredient.company_id,
    name: ingredient.name,
    allergens: ingredient.allergens,
    createdAt: ingredient.created_at,
    updatedAt: ingredient.updated_at,
  };
}

export async function createIngredient(ownerUserId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const ingredient = await menuRepository.createIngredient(company.id, data);
  return toIngredientResponse(ingredient);
}

export async function listIngredients(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const ingredients = await menuRepository.listActiveIngredientsForCompany(company.id);
  return ingredients.map(toIngredientResponse);
}

async function getIngredientOrThrow(companyId, ingredientId) {
  const ingredient = await menuRepository.findActiveIngredientByIdForCompany(ingredientId, companyId);
  if (!ingredient) {
    throw new AppError('Ingredient not found', 404);
  }
  return ingredient;
}

export async function updateIngredient(ownerUserId, ingredientId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getIngredientOrThrow(company.id, ingredientId);
  const updated = await menuRepository.updateIngredient(ingredientId, data);
  return toIngredientResponse(updated);
}

export async function deleteIngredient(ownerUserId, ingredientId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getIngredientOrThrow(company.id, ingredientId);
  await menuRepository.softDeleteIngredient(ingredientId);
}

// --- Attaching ingredients to a MASTER item's recipe ---

export async function attachIngredientToItem(ownerUserId, itemId, ingredientId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  await getIngredientOrThrow(company.id, ingredientId);

  try {
    await menuRepository.attachIngredientToItem(itemId, ingredientId);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('This ingredient is already attached to this item', 409);
    }
    throw err;
  }
}

export async function detachIngredientFromItem(ownerUserId, itemId, ingredientId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);
  await getIngredientOrThrow(company.id, ingredientId);

  const detached = await menuRepository.detachIngredientFromItem(itemId, ingredientId);
  if (!detached) {
    throw new AppError('This ingredient is not attached to this item', 404);
  }
}

export async function listItemIngredients(ownerUserId, itemId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await getItemOrThrow(company.id, itemId);

  const ingredients = await menuRepository.listAttachedIngredientsForItem(itemId);
  return ingredients.map(toIngredientResponse);
}
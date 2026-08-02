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
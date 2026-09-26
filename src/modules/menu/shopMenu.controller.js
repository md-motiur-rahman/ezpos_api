import { asyncHandler } from '../../utils/asyncHandler.js';
import * as shopMenuService from './shopMenu.service.js';

export const getResolvedMenu = asyncHandler(async (req, res) => {
  const menu = await shopMenuService.getResolvedMenu(req.actor, req.params.shopId);
  res.status(200).json(menu);
});

export const listCategories = asyncHandler(async (req, res) => {
  const categories = await shopMenuService.listCategoriesForShop(req.actor, req.params.shopId);
  res.status(200).json(categories);
});

export const setOverride = asyncHandler(async (req, res) => {
  const override = await shopMenuService.setOverride(
    req.actor,
    req.params.shopId,
    req.params.menuItemId,
    req.body
  );
  res.status(200).json(override);
});

export const clearOverride = asyncHandler(async (req, res) => {
  await shopMenuService.clearOverride(req.actor, req.params.shopId, req.params.menuItemId);
  res.status(200).json({ message: 'Override cleared - reverted to master defaults.' });
});

export const setVariantOverride = asyncHandler(async (req, res) => {
  const override = await shopMenuService.setVariantOverride(
    req.actor,
    req.params.shopId,
    req.params.variantId,
    req.body
  );
  res.status(200).json(override);
});

export const clearVariantOverride = asyncHandler(async (req, res) => {
  await shopMenuService.clearVariantOverride(req.actor, req.params.shopId, req.params.variantId);
  res.status(200).json({ message: 'Variant override cleared - reverted to master defaults.' });
});

export const createLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.createLocalItem(req.actor, req.params.shopId, req.body);
  res.status(201).json(item);
});

export const listLocalItems = asyncHandler(async (req, res) => {
  const items = await shopMenuService.listLocalItems(req.actor, req.params.shopId);
  res.status(200).json(items);
});

export const getLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.getLocalItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json(item);
});

export const updateLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.updateLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.body
  );
  res.status(200).json(item);
});

export const deleteLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.deleteLocalItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json({ message: 'Local menu item deleted.' });
});

// --- Modifiers (6.4) ---

export const setModifierOptionOverride = asyncHandler(async (req, res) => {
  const override = await shopMenuService.setModifierOptionOverride(
    req.actor,
    req.params.shopId,
    req.params.optionId,
    req.body
  );
  res.status(200).json(override);
});

export const clearModifierOptionOverride = asyncHandler(async (req, res) => {
  await shopMenuService.clearModifierOptionOverride(req.actor, req.params.shopId, req.params.optionId);
  res.status(200).json({ message: 'Modifier option override cleared - reverted to master defaults.' });
});

export const attachModifierGroupToLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.attachModifierGroupToLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.groupId
  );
  res.status(201).json({ message: 'Modifier group attached.' });
});

export const detachModifierGroupFromLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.detachModifierGroupFromLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.groupId
  );
  res.status(200).json({ message: 'Modifier group detached.' });
});

// --- Ingredients / allergens (6.5, extended by 7.2) ---

export const attachIngredientToLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.attachIngredientToLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(201).json({ message: 'Ingredient attached.' });
});

export const updateLocalItemIngredientQuantity = asyncHandler(async (req, res) => {
  await shopMenuService.updateLocalItemIngredientQuantity(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(200).json({ message: 'Ingredient quantity updated.' });
});

export const detachIngredientFromLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.detachIngredientFromLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.ingredientId
  );
  res.status(200).json({ message: 'Ingredient detached.' });
});

export const listLocalItemIngredients = asyncHandler(async (req, res) => {
  const ingredients = await shopMenuService.listLocalItemIngredients(
    req.actor,
    req.params.shopId,
    req.params.itemId
  );
  res.status(200).json(ingredients);
});
// --- Sizes on shop-only items ---

export const createLocalVariant = asyncHandler(async (req, res) => {
  const variant = await shopMenuService.createLocalVariant(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.body
  );
  res.status(201).json(variant);
});

export const listLocalVariants = asyncHandler(async (req, res) => {
  const variants = await shopMenuService.listLocalVariants(
    req.actor,
    req.params.shopId,
    req.params.itemId
  );
  res.status(200).json(variants);
});

export const updateLocalVariant = asyncHandler(async (req, res) => {
  const variant = await shopMenuService.updateLocalVariant(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId,
    req.body
  );
  res.status(200).json(variant);
});

export const deleteLocalVariant = asyncHandler(async (req, res) => {
  await shopMenuService.deleteLocalVariant(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId
  );
  res.status(200).json({ message: 'Variant deleted.' });
});

// --- A shop item's size's own recipe ---

export const attachIngredientToLocalVariant = asyncHandler(async (req, res) => {
  await shopMenuService.attachIngredientToLocalVariant(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(201).json({ message: 'Ingredient attached.' });
});

export const listLocalVariantIngredients = asyncHandler(async (req, res) => {
  const ingredients = await shopMenuService.listLocalVariantIngredients(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId
  );
  res.status(200).json(ingredients);
});

export const updateLocalVariantIngredientQuantity = asyncHandler(async (req, res) => {
  await shopMenuService.updateLocalVariantIngredientQuantity(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(200).json({ message: 'Ingredient quantity updated.' });
});

export const detachIngredientFromLocalVariant = asyncHandler(async (req, res) => {
  await shopMenuService.detachIngredientFromLocalVariant(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId
  );
  res.status(200).json({ message: 'Ingredient detached.' });
});

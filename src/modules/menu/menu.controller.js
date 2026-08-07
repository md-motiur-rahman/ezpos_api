import { asyncHandler } from '../../utils/asyncHandler.js';
import * as menuService from './menu.service.js';

export const createCategory = asyncHandler(async (req, res) => {
  const category = await menuService.createCategory(req.user.id, req.body);
  res.status(201).json(category);
});

export const listCategories = asyncHandler(async (req, res) => {
  const categories = await menuService.listCategories(req.user.id);
  res.status(200).json(categories);
});

export const updateCategory = asyncHandler(async (req, res) => {
  const category = await menuService.updateCategory(req.user.id, req.params.categoryId, req.body);
  res.status(200).json(category);
});

export const deleteCategory = asyncHandler(async (req, res) => {
  await menuService.deleteCategory(req.user.id, req.params.categoryId);
  res.status(200).json({ message: 'Category deleted.' });
});

export const createItem = asyncHandler(async (req, res) => {
  const item = await menuService.createItem(req.user.id, req.body);
  res.status(201).json(item);
});

export const listItems = asyncHandler(async (req, res) => {
  const items = await menuService.listItems(req.user.id, req.query);
  res.status(200).json(items);
});

export const getItem = asyncHandler(async (req, res) => {
  const item = await menuService.getItem(req.user.id, req.params.itemId);
  res.status(200).json(item);
});

export const updateItem = asyncHandler(async (req, res) => {
  const item = await menuService.updateItem(req.user.id, req.params.itemId, req.body);
  res.status(200).json(item);
});

export const deleteItem = asyncHandler(async (req, res) => {
  await menuService.deleteItem(req.user.id, req.params.itemId);
  res.status(200).json({ message: 'Menu item deleted.' });
});

// --- Variants (6.3) ---

export const createVariant = asyncHandler(async (req, res) => {
  const variant = await menuService.createVariant(req.user.id, req.params.itemId, req.body);
  res.status(201).json(variant);
});

export const listVariants = asyncHandler(async (req, res) => {
  const variants = await menuService.listVariants(req.user.id, req.params.itemId);
  res.status(200).json(variants);
});

export const updateVariant = asyncHandler(async (req, res) => {
  const variant = await menuService.updateVariant(
    req.user.id,
    req.params.itemId,
    req.params.variantId,
    req.body
  );
  res.status(200).json(variant);
});

export const deleteVariant = asyncHandler(async (req, res) => {
  await menuService.deleteVariant(req.user.id, req.params.itemId, req.params.variantId);
  res.status(200).json({ message: 'Variant deleted.' });
});

// --- Modifiers (6.4) ---

export const createModifierGroup = asyncHandler(async (req, res) => {
  const group = await menuService.createModifierGroup(req.user.id, req.body);
  res.status(201).json(group);
});

export const listModifierGroups = asyncHandler(async (req, res) => {
  const groups = await menuService.listModifierGroups(req.user.id);
  res.status(200).json(groups);
});

export const updateModifierGroup = asyncHandler(async (req, res) => {
  const group = await menuService.updateModifierGroup(req.user.id, req.params.groupId, req.body);
  res.status(200).json(group);
});

export const deleteModifierGroup = asyncHandler(async (req, res) => {
  await menuService.deleteModifierGroup(req.user.id, req.params.groupId);
  res.status(200).json({ message: 'Modifier group deleted.' });
});

export const createModifierOption = asyncHandler(async (req, res) => {
  const option = await menuService.createModifierOption(req.user.id, req.params.groupId, req.body);
  res.status(201).json(option);
});

export const listModifierOptions = asyncHandler(async (req, res) => {
  const options = await menuService.listModifierOptions(req.user.id, req.params.groupId);
  res.status(200).json(options);
});

export const updateModifierOption = asyncHandler(async (req, res) => {
  const option = await menuService.updateModifierOption(
    req.user.id,
    req.params.groupId,
    req.params.optionId,
    req.body
  );
  res.status(200).json(option);
});

export const deleteModifierOption = asyncHandler(async (req, res) => {
  await menuService.deleteModifierOption(req.user.id, req.params.groupId, req.params.optionId);
  res.status(200).json({ message: 'Modifier option deleted.' });
});

export const attachModifierGroupToItem = asyncHandler(async (req, res) => {
  await menuService.attachModifierGroupToItem(req.user.id, req.params.itemId, req.params.groupId);
  res.status(201).json({ message: 'Modifier group attached.' });
});

export const detachModifierGroupFromItem = asyncHandler(async (req, res) => {
  await menuService.detachModifierGroupFromItem(req.user.id, req.params.itemId, req.params.groupId);
  res.status(200).json({ message: 'Modifier group detached.' });
});

export const listItemModifierGroups = asyncHandler(async (req, res) => {
  const groups = await menuService.listItemModifierGroups(req.user.id, req.params.itemId);
  res.status(200).json(groups);
});

// --- Ingredients / allergens (6.5, extended by 7.2) ---

export const createIngredient = asyncHandler(async (req, res) => {
  const ingredient = await menuService.createIngredient(req.user.id, req.body);
  res.status(201).json(ingredient);
});

export const listIngredients = asyncHandler(async (req, res) => {
  const ingredients = await menuService.listIngredients(req.user.id);
  res.status(200).json(ingredients);
});

export const updateIngredient = asyncHandler(async (req, res) => {
  const ingredient = await menuService.updateIngredient(req.user.id, req.params.ingredientId, req.body);
  res.status(200).json(ingredient);
});

export const deleteIngredient = asyncHandler(async (req, res) => {
  await menuService.deleteIngredient(req.user.id, req.params.ingredientId);
  res.status(200).json({ message: 'Ingredient deleted.' });
});

export const attachIngredientToItem = asyncHandler(async (req, res) => {
  await menuService.attachIngredientToItem(
    req.user.id,
    req.params.itemId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(201).json({ message: 'Ingredient attached.' });
});

export const updateItemIngredientQuantity = asyncHandler(async (req, res) => {
  await menuService.updateItemIngredientQuantity(
    req.user.id,
    req.params.itemId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(200).json({ message: 'Ingredient quantity updated.' });
});

export const detachIngredientFromItem = asyncHandler(async (req, res) => {
  await menuService.detachIngredientFromItem(req.user.id, req.params.itemId, req.params.ingredientId);
  res.status(200).json({ message: 'Ingredient detached.' });
});

export const listItemIngredients = asyncHandler(async (req, res) => {
  const ingredients = await menuService.listItemIngredients(req.user.id, req.params.itemId);
  res.status(200).json(ingredients);
});

// --- Variant recipes (7.2) ---

export const attachIngredientToVariant = asyncHandler(async (req, res) => {
  await menuService.attachIngredientToVariant(
    req.user.id,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(201).json({ message: 'Ingredient attached.' });
});

export const updateVariantIngredientQuantity = asyncHandler(async (req, res) => {
  await menuService.updateVariantIngredientQuantity(
    req.user.id,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(200).json({ message: 'Ingredient quantity updated.' });
});

export const detachIngredientFromVariant = asyncHandler(async (req, res) => {
  await menuService.detachIngredientFromVariant(
    req.user.id,
    req.params.itemId,
    req.params.variantId,
    req.params.ingredientId
  );
  res.status(200).json({ message: 'Ingredient detached.' });
});

export const listVariantIngredients = asyncHandler(async (req, res) => {
  const ingredients = await menuService.listVariantIngredients(
    req.user.id,
    req.params.itemId,
    req.params.variantId
  );
  res.status(200).json(ingredients);
});

// --- Modifier option recipes (7.2) ---

export const attachIngredientToModifierOption = asyncHandler(async (req, res) => {
  await menuService.attachIngredientToModifierOption(
    req.user.id,
    req.params.groupId,
    req.params.optionId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(201).json({ message: 'Ingredient attached.' });
});

export const updateModifierOptionIngredientQuantity = asyncHandler(async (req, res) => {
  await menuService.updateModifierOptionIngredientQuantity(
    req.user.id,
    req.params.groupId,
    req.params.optionId,
    req.params.ingredientId,
    req.body.quantity
  );
  res.status(200).json({ message: 'Ingredient quantity updated.' });
});

export const detachIngredientFromModifierOption = asyncHandler(async (req, res) => {
  await menuService.detachIngredientFromModifierOption(
    req.user.id,
    req.params.groupId,
    req.params.optionId,
    req.params.ingredientId
  );
  res.status(200).json({ message: 'Ingredient detached.' });
});

export const listModifierOptionIngredients = asyncHandler(async (req, res) => {
  const ingredients = await menuService.listModifierOptionIngredients(
    req.user.id,
    req.params.groupId,
    req.params.optionId
  );
  res.status(200).json(ingredients);
});
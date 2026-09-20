import { Router } from 'express';
import { requireActiveBilling } from '../../middleware/requireActiveBilling.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as menuController from './menu.controller.js';
import {
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamSchema,
  createItemSchema,
  updateItemSchema,
  itemIdParamSchema,
  itemListQuerySchema,
  createVariantSchema,
  updateVariantSchema,
  variantIdParamSchema,
  createModifierGroupSchema,
  updateModifierGroupSchema,
  modifierGroupIdParamSchema,
  createModifierOptionSchema,
  updateModifierOptionSchema,
  modifierOptionIdParamSchema,
  itemModifierGroupParamSchema,
  createIngredientSchema,
  updateIngredientSchema,
  ingredientIdParamSchema,
  itemIngredientParamSchema,
  recipeQuantitySchema,
  variantIngredientParamSchema,
  modifierOptionIngredientParamSchema,
} from './menu.validation.js';

/**
 * Mounted at /mine inside company.routes.js (router.use('/mine', menuRoutes))
 * - NOT an independent top-level mount like Module 5's rota/staff routes.
 * Owner-only, per the spec's exact wording ("Master menu defined centrally
 * by the owner") - no manage_menu permission exists, no staff-actor case to
 * support, so requireStaffOrOwnerAuth/mergeParams/mount-ordering concerns
 * from 4.5/5.x simply don't apply here. requireAuth is already applied by
 * the parent company router.
 *
 * Verified empirically that nesting this at '/mine' doesn't collide with
 * company.routes.js's own exact '/mine' routes (GET/PATCH/DELETE) - use()
 * is prefix-based, get()/patch() are exact-match, no overlap.
 *
 * requireActiveBilling gates every write below - unchanged, owner-only
 * middleware (this router has no shopId in its path at all, and no
 * staff-actor case to support in the first place, per this doc's own
 * opening paragraph), reused as-is rather than the shop-scoped
 * requireActiveBillingForShop every other newly-gated module uses. Reads
 * stay open regardless of billing state.
 */
const router = Router();

router.post(
  '/menu-categories',
  requireActiveBilling,
  validateBody(createCategorySchema),
  menuController.createCategory
);
router.get('/menu-categories', menuController.listCategories);
router.patch(
  '/menu-categories/:categoryId',
  requireActiveBilling,
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  menuController.updateCategory
);
router.delete(
  '/menu-categories/:categoryId',
  requireActiveBilling,
  validateParams(categoryIdParamSchema),
  menuController.deleteCategory
);

router.post(
  '/menu-items',
  requireActiveBilling,
  validateBody(createItemSchema),
  menuController.createItem
);
router.get('/menu-items', validateQuery(itemListQuerySchema), menuController.listItems);
router.get('/menu-items/:itemId', validateParams(itemIdParamSchema), menuController.getItem);
router.patch(
  '/menu-items/:itemId',
  requireActiveBilling,
  validateParams(itemIdParamSchema),
  validateBody(updateItemSchema),
  menuController.updateItem
);
router.delete(
  '/menu-items/:itemId',
  requireActiveBilling,
  validateParams(itemIdParamSchema),
  menuController.deleteItem
);

// --- Variants (6.3) ---

router.post(
  '/menu-items/:itemId/variants',
  requireActiveBilling,
  validateParams(itemIdParamSchema),
  validateBody(createVariantSchema),
  menuController.createVariant
);
router.get(
  '/menu-items/:itemId/variants',
  validateParams(itemIdParamSchema),
  menuController.listVariants
);
router.patch(
  '/menu-items/:itemId/variants/:variantId',
  requireActiveBilling,
  validateParams(variantIdParamSchema),
  validateBody(updateVariantSchema),
  menuController.updateVariant
);
router.delete(
  '/menu-items/:itemId/variants/:variantId',
  requireActiveBilling,
  validateParams(variantIdParamSchema),
  menuController.deleteVariant
);

// --- Modifiers (6.4) ---

router.post(
  '/modifier-groups',
  requireActiveBilling,
  validateBody(createModifierGroupSchema),
  menuController.createModifierGroup
);
router.get('/modifier-groups', menuController.listModifierGroups);
router.patch(
  '/modifier-groups/:groupId',
  requireActiveBilling,
  validateParams(modifierGroupIdParamSchema),
  validateBody(updateModifierGroupSchema),
  menuController.updateModifierGroup
);
router.delete(
  '/modifier-groups/:groupId',
  requireActiveBilling,
  validateParams(modifierGroupIdParamSchema),
  menuController.deleteModifierGroup
);

router.post(
  '/modifier-groups/:groupId/options',
  requireActiveBilling,
  validateParams(modifierGroupIdParamSchema),
  validateBody(createModifierOptionSchema),
  menuController.createModifierOption
);
router.get(
  '/modifier-groups/:groupId/options',
  validateParams(modifierGroupIdParamSchema),
  menuController.listModifierOptions
);
router.patch(
  '/modifier-groups/:groupId/options/:optionId',
  requireActiveBilling,
  validateParams(modifierOptionIdParamSchema),
  validateBody(updateModifierOptionSchema),
  menuController.updateModifierOption
);
router.delete(
  '/modifier-groups/:groupId/options/:optionId',
  requireActiveBilling,
  validateParams(modifierOptionIdParamSchema),
  menuController.deleteModifierOption
);

router.post(
  '/menu-items/:itemId/modifier-groups/:groupId',
  requireActiveBilling,
  validateParams(itemModifierGroupParamSchema),
  menuController.attachModifierGroupToItem
);
router.get(
  '/menu-items/:itemId/modifier-groups',
  validateParams(itemIdParamSchema),
  menuController.listItemModifierGroups
);
router.delete(
  '/menu-items/:itemId/modifier-groups/:groupId',
  requireActiveBilling,
  validateParams(itemModifierGroupParamSchema),
  menuController.detachModifierGroupFromItem
);

// --- Ingredients / allergens (6.5) ---

router.post(
  '/ingredients',
  requireActiveBilling,
  validateBody(createIngredientSchema),
  menuController.createIngredient
);
router.get('/ingredients', menuController.listIngredients);
router.patch(
  '/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(ingredientIdParamSchema),
  validateBody(updateIngredientSchema),
  menuController.updateIngredient
);
router.delete(
  '/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(ingredientIdParamSchema),
  menuController.deleteIngredient
);

router.post(
  '/menu-items/:itemId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(itemIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.attachIngredientToItem
);
router.get(
  '/menu-items/:itemId/ingredients',
  validateParams(itemIdParamSchema),
  menuController.listItemIngredients
);
router.patch(
  '/menu-items/:itemId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(itemIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.updateItemIngredientQuantity
);
router.delete(
  '/menu-items/:itemId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(itemIngredientParamSchema),
  menuController.detachIngredientFromItem
);

// --- Variant recipes (7.2) ---

router.post(
  '/menu-items/:itemId/variants/:variantId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(variantIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.attachIngredientToVariant
);
router.get(
  '/menu-items/:itemId/variants/:variantId/ingredients',
  validateParams(variantIdParamSchema),
  menuController.listVariantIngredients
);
router.patch(
  '/menu-items/:itemId/variants/:variantId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(variantIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.updateVariantIngredientQuantity
);
router.delete(
  '/menu-items/:itemId/variants/:variantId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(variantIngredientParamSchema),
  menuController.detachIngredientFromVariant
);

// --- Modifier option recipes (7.2) ---

router.post(
  '/modifier-groups/:groupId/options/:optionId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(modifierOptionIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.attachIngredientToModifierOption
);
router.get(
  '/modifier-groups/:groupId/options/:optionId/ingredients',
  validateParams(modifierOptionIdParamSchema),
  menuController.listModifierOptionIngredients
);
router.patch(
  '/modifier-groups/:groupId/options/:optionId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(modifierOptionIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  menuController.updateModifierOptionIngredientQuantity
);
router.delete(
  '/modifier-groups/:groupId/options/:optionId/ingredients/:ingredientId',
  requireActiveBilling,
  validateParams(modifierOptionIngredientParamSchema),
  menuController.detachIngredientFromModifierOption
);

export default router;
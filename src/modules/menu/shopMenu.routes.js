import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as shopMenuController from './shopMenu.controller.js';
import {
  createLocalItemSchema,
  updateLocalItemSchema,
  localItemIdParamSchema,
  overrideSchema,
  menuItemIdParamSchema,
  variantOverrideSchema,
  variantIdParamSchema,
  modifierOptionOverrideSchema,
  modifierOptionIdParamSchema,
  localItemModifierGroupParamSchema,
  localItemIngredientParamSchema,
} from './shopMenu.validation.js';
import { recipeQuantitySchema } from './menu.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/menu in app.js, same pattern
 * as rota/swap-requests/attendance (5.x) - NOT nested under shop.routes.js's
 * owner-only requireAuth, so staff sessions (a Manager, or an empowered
 * Shift Manager) can reach it.
 *
 * mergeParams: true required even for this top-level mount - verified
 * empirically in 4.5.
 *
 * requireActiveBillingForShop gates every write below (overrides, local
 * items, modifier attachments, recipe ingredients) - reads stay open
 * regardless of billing state.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

// The resolved, ready-to-use view - reads stay open to any in-scope actor.
router.get('/', validateParams(shopIdOnlyParamSchema), shopMenuController.getResolvedMenu);

// Category NAMES for the resolved menu's bare categoryId (Module 13/14) -
// the only other source, /api/companies/mine/menu-categories, is owner-only
// (requireAuth), so a staff actor building an order has nothing to label a
// categoryId with otherwise. Registered before any other route here so
// there's no ambiguity if a future /:something segment is ever added at
// this same depth - same discipline as 8.3's '/latest' before '/:scanId'.
router.get('/categories', validateParams(shopIdOnlyParamSchema), shopMenuController.listCategories);

router.patch(
  '/overrides/:menuItemId',
  requireActiveBillingForShop,
  validateParams(menuItemIdParamSchema),
  validateBody(overrideSchema),
  shopMenuController.setOverride
);
router.delete(
  '/overrides/:menuItemId',
  requireActiveBillingForShop,
  validateParams(menuItemIdParamSchema),
  shopMenuController.clearOverride
);

// Variant overrides (6.3) - one level down from item overrides, same shape,
// distinct static prefix so there's no ambiguity with /overrides/:menuItemId.
router.patch(
  '/variants/:variantId',
  requireActiveBillingForShop,
  validateParams(variantIdParamSchema),
  validateBody(variantOverrideSchema),
  shopMenuController.setVariantOverride
);
router.delete(
  '/variants/:variantId',
  requireActiveBillingForShop,
  validateParams(variantIdParamSchema),
  shopMenuController.clearVariantOverride
);

router.post(
  '/items',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(createLocalItemSchema),
  shopMenuController.createLocalItem
);
router.get('/items', validateParams(shopIdOnlyParamSchema), shopMenuController.listLocalItems);
router.get('/items/:itemId', validateParams(localItemIdParamSchema), shopMenuController.getLocalItem);
router.patch(
  '/items/:itemId',
  requireActiveBillingForShop,
  validateParams(localItemIdParamSchema),
  validateBody(updateLocalItemSchema),
  shopMenuController.updateLocalItem
);
router.delete(
  '/items/:itemId',
  requireActiveBillingForShop,
  validateParams(localItemIdParamSchema),
  shopMenuController.deleteLocalItem
);

// --- Modifiers (6.4) ---

router.patch(
  '/modifier-options/:optionId',
  requireActiveBillingForShop,
  validateParams(modifierOptionIdParamSchema),
  validateBody(modifierOptionOverrideSchema),
  shopMenuController.setModifierOptionOverride
);
router.delete(
  '/modifier-options/:optionId',
  requireActiveBillingForShop,
  validateParams(modifierOptionIdParamSchema),
  shopMenuController.clearModifierOptionOverride
);

router.post(
  '/items/:itemId/modifier-groups/:groupId',
  requireActiveBillingForShop,
  validateParams(localItemModifierGroupParamSchema),
  shopMenuController.attachModifierGroupToLocalItem
);
router.delete(
  '/items/:itemId/modifier-groups/:groupId',
  requireActiveBillingForShop,
  validateParams(localItemModifierGroupParamSchema),
  shopMenuController.detachModifierGroupFromLocalItem
);

// --- Ingredients / allergens (6.5, extended by 7.2) ---

router.post(
  '/items/:itemId/ingredients/:ingredientId',
  requireActiveBillingForShop,
  validateParams(localItemIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  shopMenuController.attachIngredientToLocalItem
);
router.get(
  '/items/:itemId/ingredients',
  validateParams(localItemIdParamSchema),
  shopMenuController.listLocalItemIngredients
);
router.patch(
  '/items/:itemId/ingredients/:ingredientId',
  requireActiveBillingForShop,
  validateParams(localItemIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  shopMenuController.updateLocalItemIngredientQuantity
);
router.delete(
  '/items/:itemId/ingredients/:ingredientId',
  requireActiveBillingForShop,
  validateParams(localItemIngredientParamSchema),
  shopMenuController.detachIngredientFromLocalItem
);

export default router;
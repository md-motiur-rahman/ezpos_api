import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
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
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

// The resolved, ready-to-use view - reads stay open to any in-scope actor.
router.get('/', validateParams(shopIdOnlyParamSchema), shopMenuController.getResolvedMenu);

router.patch(
  '/overrides/:menuItemId',
  validateParams(menuItemIdParamSchema),
  validateBody(overrideSchema),
  shopMenuController.setOverride
);
router.delete(
  '/overrides/:menuItemId',
  validateParams(menuItemIdParamSchema),
  shopMenuController.clearOverride
);

// Variant overrides (6.3) - one level down from item overrides, same shape,
// distinct static prefix so there's no ambiguity with /overrides/:menuItemId.
router.patch(
  '/variants/:variantId',
  validateParams(variantIdParamSchema),
  validateBody(variantOverrideSchema),
  shopMenuController.setVariantOverride
);
router.delete(
  '/variants/:variantId',
  validateParams(variantIdParamSchema),
  shopMenuController.clearVariantOverride
);

router.post(
  '/items',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createLocalItemSchema),
  shopMenuController.createLocalItem
);
router.get('/items', validateParams(shopIdOnlyParamSchema), shopMenuController.listLocalItems);
router.get('/items/:itemId', validateParams(localItemIdParamSchema), shopMenuController.getLocalItem);
router.patch(
  '/items/:itemId',
  validateParams(localItemIdParamSchema),
  validateBody(updateLocalItemSchema),
  shopMenuController.updateLocalItem
);
router.delete(
  '/items/:itemId',
  validateParams(localItemIdParamSchema),
  shopMenuController.deleteLocalItem
);

// --- Modifiers (6.4) ---

router.patch(
  '/modifier-options/:optionId',
  validateParams(modifierOptionIdParamSchema),
  validateBody(modifierOptionOverrideSchema),
  shopMenuController.setModifierOptionOverride
);
router.delete(
  '/modifier-options/:optionId',
  validateParams(modifierOptionIdParamSchema),
  shopMenuController.clearModifierOptionOverride
);

router.post(
  '/items/:itemId/modifier-groups/:groupId',
  validateParams(localItemModifierGroupParamSchema),
  shopMenuController.attachModifierGroupToLocalItem
);
router.delete(
  '/items/:itemId/modifier-groups/:groupId',
  validateParams(localItemModifierGroupParamSchema),
  shopMenuController.detachModifierGroupFromLocalItem
);

// --- Ingredients / allergens (6.5, extended by 7.2) ---

router.post(
  '/items/:itemId/ingredients/:ingredientId',
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
  validateParams(localItemIngredientParamSchema),
  validateBody(recipeQuantitySchema),
  shopMenuController.updateLocalItemIngredientQuantity
);
router.delete(
  '/items/:itemId/ingredients/:ingredientId',
  validateParams(localItemIngredientParamSchema),
  shopMenuController.detachIngredientFromLocalItem
);

export default router;
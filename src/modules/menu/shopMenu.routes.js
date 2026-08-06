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
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

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

// --- Ingredients / allergens (6.5) ---

router.post(
  '/items/:itemId/ingredients/:ingredientId',
  validateParams(localItemIngredientParamSchema),
  shopMenuController.attachIngredientToLocalItem
);
router.delete(
  '/items/:itemId/ingredients/:ingredientId',
  validateParams(localItemIngredientParamSchema),
  shopMenuController.detachIngredientFromLocalItem
);

export default router;
import { Router } from 'express';
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
 */
const router = Router();

router.post('/menu-categories', validateBody(createCategorySchema), menuController.createCategory);
router.get('/menu-categories', menuController.listCategories);
router.patch(
  '/menu-categories/:categoryId',
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  menuController.updateCategory
);
router.delete(
  '/menu-categories/:categoryId',
  validateParams(categoryIdParamSchema),
  menuController.deleteCategory
);

router.post('/menu-items', validateBody(createItemSchema), menuController.createItem);
router.get('/menu-items', validateQuery(itemListQuerySchema), menuController.listItems);
router.get('/menu-items/:itemId', validateParams(itemIdParamSchema), menuController.getItem);
router.patch(
  '/menu-items/:itemId',
  validateParams(itemIdParamSchema),
  validateBody(updateItemSchema),
  menuController.updateItem
);
router.delete('/menu-items/:itemId', validateParams(itemIdParamSchema), menuController.deleteItem);

// --- Variants (6.3) ---

router.post(
  '/menu-items/:itemId/variants',
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
  validateParams(variantIdParamSchema),
  validateBody(updateVariantSchema),
  menuController.updateVariant
);
router.delete(
  '/menu-items/:itemId/variants/:variantId',
  validateParams(variantIdParamSchema),
  menuController.deleteVariant
);

export default router;
import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as inventoryController from './inventory.controller.js';
import {
  createInventoryItemSchema,
  updateInventoryItemSchema,
  addStockBodySchema,
  inventoryItemIdParamSchema,
  inventoryListQuerySchema,
  itemSupplierParamSchema,
  attachSupplierBodySchema,
  updateItemSupplierBodySchema,
  itemIngredientParamSchema,
  linkIngredientBodySchema,
  updateIngredientLinkBodySchema,
} from './inventory.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/inventory-items in app.js,
 * same proven pattern as rota/swap-requests/attendance/menu (5.x/6.x) -
 * NOT nested under shop.routes.js's owner-only requireAuth, so staff
 * sessions (Manager by default, or a Chef granted view-only) can reach it.
 *
 * mergeParams: true required even for this top-level mount - verified
 * empirically in 4.5.
 *
 * Unlike Module 6's menu, reads are NOT open to every in-scope actor here -
 * VIEW_INVENTORY is checked in the service layer for every route, including
 * GET, since stock levels are back-of-house rather than customer-facing.
 *
 * requireActiveBillingForShop gates every write below (create/update/delete
 * an item, every supplier/ingredient link) - reads stay open regardless of
 * billing state, same split as every other newly-gated module.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(createInventoryItemSchema),
  inventoryController.createItem
);
router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(inventoryListQuerySchema),
  inventoryController.listItems
);
router.get('/:itemId', validateParams(inventoryItemIdParamSchema), inventoryController.getItem);
router.patch(
  '/:itemId',
  requireActiveBillingForShop,
  validateParams(inventoryItemIdParamSchema),
  validateBody(updateInventoryItemSchema),
  inventoryController.updateItem
);
router.post(
  '/:itemId/add-stock',
  requireActiveBillingForShop,
  validateParams(inventoryItemIdParamSchema),
  validateBody(addStockBodySchema),
  inventoryController.addStock
);
router.delete(
  '/:itemId',
  requireActiveBillingForShop,
  validateParams(inventoryItemIdParamSchema),
  inventoryController.deleteItem
);

// --- Item <-> supplier linking (7.4) ---

router.post(
  '/:itemId/suppliers/:supplierId',
  requireActiveBillingForShop,
  validateParams(itemSupplierParamSchema),
  validateBody(attachSupplierBodySchema),
  inventoryController.attachSupplierToItem
);
router.get(
  '/:itemId/suppliers',
  validateParams(inventoryItemIdParamSchema),
  inventoryController.listItemSuppliers
);
router.patch(
  '/:itemId/suppliers/:supplierId',
  requireActiveBillingForShop,
  validateParams(itemSupplierParamSchema),
  validateBody(updateItemSupplierBodySchema),
  inventoryController.updateItemSupplierDefault
);
router.delete(
  '/:itemId/suppliers/:supplierId',
  requireActiveBillingForShop,
  validateParams(itemSupplierParamSchema),
  inventoryController.detachSupplierFromItem
);

// --- Ingredient <-> inventory item linking (7.9) ---
//
// Hung off the inventory item rather than the ingredient, even though the
// uniqueness constraint is per-ingredient: the link is shop-scoped data and
// this router is already the shop-scoped one. The ingredient side lives
// under /api/companies/mine (company-level master data), which has no shop
// in its path to scope a link by.

router.post(
  '/:itemId/ingredient-links/:ingredientId',
  requireActiveBillingForShop,
  validateParams(itemIngredientParamSchema),
  validateBody(linkIngredientBodySchema),
  inventoryController.linkIngredientToItem
);
router.get(
  '/:itemId/ingredient-links',
  validateParams(inventoryItemIdParamSchema),
  inventoryController.listIngredientLinksForItem
);
router.patch(
  '/:itemId/ingredient-links/:ingredientId',
  requireActiveBillingForShop,
  validateParams(itemIngredientParamSchema),
  validateBody(updateIngredientLinkBodySchema),
  inventoryController.updateIngredientLink
);
router.delete(
  '/:itemId/ingredient-links/:ingredientId',
  requireActiveBillingForShop,
  validateParams(itemIngredientParamSchema),
  inventoryController.unlinkIngredientFromItem
);

export default router;
import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as supplierController from './supplier.controller.js';
import { createSupplierSchema, updateSupplierSchema, supplierIdParamSchema } from './supplier.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/suppliers in app.js, same
 * proven pattern as inventory-items (7.1) - NOT nested under shop.routes.js's
 * owner-only requireAuth, so staff sessions can reach it.
 *
 * Same permission pair as inventory-items: VIEW_INVENTORY to read,
 * MANAGE_INVENTORY to mutate - suppliers are inventory-adjacent,
 * back-of-house data, not customer-facing like Module 6's menu.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createSupplierSchema),
  supplierController.createSupplier
);
router.get('/', validateParams(shopIdOnlyParamSchema), supplierController.listSuppliers);
router.get('/:supplierId', validateParams(supplierIdParamSchema), supplierController.getSupplier);
router.patch(
  '/:supplierId',
  validateParams(supplierIdParamSchema),
  validateBody(updateSupplierSchema),
  supplierController.updateSupplier
);
router.delete('/:supplierId', validateParams(supplierIdParamSchema), supplierController.deleteSupplier);

export default router;
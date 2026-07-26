import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireActiveBilling } from '../../middleware/requireActiveBilling.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as shopController from './shop.controller.js';
import shopAddonRoutes from './shopAddon.routes.js';
import { createShopSchema, updateShopSchema, shopIdParamSchema } from './shop.validation.js';

const router = Router();

router.use(requireAuth);

// Nested add-on routes (Module 3.3). Mounted before the /:id routes so the
// more specific path wins - Express matches in definition order.
router.use('/:shopId/addons', shopAddonRoutes);

// Only creation is billing-gated (3.6): it adds a new billable thing. Listing,
// viewing, editing and closing stay available while locked so an owner can see
// and reduce their bill.
router.post('/', requireActiveBilling, validateBody(createShopSchema), shopController.createShop);
router.get('/', shopController.listMyShops);
router.get('/:id', validateParams(shopIdParamSchema), shopController.getMyShop);
router.patch(
  '/:id',
  validateParams(shopIdParamSchema),
  validateBody(updateShopSchema),
  shopController.updateMyShop
);
router.delete('/:id', validateParams(shopIdParamSchema), shopController.deleteMyShop);

export default router;
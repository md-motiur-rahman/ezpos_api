import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as shopController from './shop.controller.js';
import { createShopSchema, updateShopSchema, shopIdParamSchema } from './shop.validation.js';

const router = Router();

router.use(requireAuth);

router.post('/', validateBody(createShopSchema), shopController.createShop);
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
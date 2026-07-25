import { Router } from 'express';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as shopAddonController from './shopAddon.controller.js';
import {
  activateAddonSchema,
  shopIdParamsSchema,
  addonParamsSchema,
} from './shopAddon.validation.js';

// mergeParams so :shopId from the parent router (/api/shops/:shopId/addons)
// is visible here. requireAuth is already applied by the parent router.
const router = Router({ mergeParams: true });

router.post(
  '/',
  validateParams(shopIdParamsSchema),
  validateBody(activateAddonSchema),
  shopAddonController.activateAddon
);
router.get('/', validateParams(shopIdParamsSchema), shopAddonController.listAddons);
router.delete(
  '/:addonType',
  validateParams(addonParamsSchema),
  shopAddonController.deactivateAddon
);

export default router;
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
} from './shopMenu.validation.js';
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
 * Route shapes here (/overrides/:menuItemId, /items vs /items/:itemId) all
 * mirror patterns already proven safe in 6.1 and elsewhere - no new
 * collision class to re-verify (unlike 5.4's /comparison vs /:recordId,
 * which were both single-segment against the router root).
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

export default router;
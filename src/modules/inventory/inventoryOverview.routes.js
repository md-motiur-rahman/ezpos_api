import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validateQuery } from '../../middleware/validate.js';
import * as inventoryController from './inventory.controller.js';
import { inventoryListQuerySchema } from './inventory.validation.js';

/**
 * Mounted independently in app.js at /api/companies/mine/inventory-overview
 * (7.8) - owner-only (requireAuth, not requireStaffOrOwnerAuth), since no
 * staff role has authority spanning more than one shop anywhere in this
 * system. Kept as its own file rather than folded into inventory.routes.js
 * because that router is mergeParams: true under /:shopId and uses
 * requireStaffOrOwnerAuth - genuinely different mounting shape, not just a
 * different path.
 */
const router = Router();

router.use(requireAuth);

router.get('/', validateQuery(inventoryListQuerySchema), inventoryController.listItemsForCompany);

export default router;

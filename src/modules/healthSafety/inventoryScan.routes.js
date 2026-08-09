import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as inventoryScanController from './inventoryScan.controller.js';
import { createScanSchema, scanIdParamSchema } from './inventoryScan.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/inventory-scans in app.js
 * (8.2), same proven pattern as inventory-items (7.1), suppliers (7.4), and
 * wastage-logs (7.7) - NOT nested under shop.routes.js's owner-only
 * requireAuth, so staff sessions can reach it.
 *
 * PERFORM_HEALTH_SAFETY gates every route here, including GET - same
 * "reading and logging share one permission gate" precedent as 7.7's
 * wastage logs. No PATCH, no DELETE - immutable once created, a scan is a
 * record of a physical event, not ongoing configuration.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createScanSchema),
  inventoryScanController.createScan
);
router.get('/', validateParams(shopIdOnlyParamSchema), inventoryScanController.listScans);
router.get('/:scanId', validateParams(scanIdParamSchema), inventoryScanController.getScan);

export default router;

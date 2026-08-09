import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import * as inventoryScanController from './inventoryScan.controller.js';
import {
  createScanSchema,
  scanIdParamSchema,
  resolveScanSchema,
} from './inventoryScan.validation.js';
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
// Registered BEFORE '/:scanId' below - deliberately, and load-bearing the
// same way app.js's mount ordering is: '/:scanId' would otherwise capture
// the literal path segment 'latest' as if it were a scan id, and fail the
// UUID check in scanIdParamSchema with a 400 instead of ever reaching this
// route. Same "specific route before the broader/parameterized one"
// principle as every /api/shops/:shopId/* mount in app.js, just scoped to
// this one router instead of the whole app.
router.get('/latest', validateParams(shopIdOnlyParamSchema), inventoryScanController.listLatestScans);
// Same reasoning as '/latest' above, and registered for the same reason -
// '/expired' must come before '/:scanId' too, or it would be swallowed the
// identical way.
router.get('/expired', validateParams(shopIdOnlyParamSchema), inventoryScanController.listExpiredScans);
router.get('/:scanId', validateParams(scanIdParamSchema), inventoryScanController.getScan);

// --- Print log (8.3) ---

router.post(
  '/:scanId/print',
  validateParams(scanIdParamSchema),
  inventoryScanController.triggerPrint
);
router.get(
  '/:scanId/prints',
  validateParams(scanIdParamSchema),
  inventoryScanController.listPrints
);

// --- Auto-flagging + resolution (8.4) ---

router.post(
  '/:scanId/resolve',
  validateParams(scanIdParamSchema),
  validateBody(resolveScanSchema),
  inventoryScanController.resolveScan
);
router.get(
  '/:scanId/resolution',
  validateParams(scanIdParamSchema),
  inventoryScanController.getResolution
);

export default router;

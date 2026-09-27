import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';
import { scanReceiptSchema } from './receiptScan.validation.js';
import * as receiptScanController from './receiptScan.controller.js';

/**
 * Mounted at /api/shops/:shopId/receipt-scan (Module 10.5). Behind the
 * billing gate like every other paid-feature write in this app
 * (`requireActiveBillingForShop`) — this one calls an external, metered
 * service on every request, so it belongs squarely with the rest of what
 * that gate protects. MANAGE_INVENTORY is checked in the service, same
 * pattern as every other inventory-adjacent route.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(scanReceiptSchema),
  receiptScanController.scanReceipt
);

export default router;

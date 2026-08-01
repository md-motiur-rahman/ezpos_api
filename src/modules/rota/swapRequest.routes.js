import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import * as swapRequestController from './swapRequest.controller.js';
import {
  createSwapRequestSchema,
  requestIdParamSchema,
  statusQuerySchema,
} from './swapRequest.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/swap-requests in app.js, same
 * pattern as rota.routes.js (5.1) and staff.routes.js (4.5) - NOT nested
 * under shop.routes.js's owner-only requireAuth, so staff sessions (e.g. a
 * Server requesting their own swap) can reach it.
 *
 * mergeParams: true required even for this top-level mount - verified
 * empirically in 4.5.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateBody(createSwapRequestSchema),
  swapRequestController.createSwapRequest
);
router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(statusQuerySchema),
  swapRequestController.listSwapRequests
);
router.get('/:requestId', validateParams(requestIdParamSchema), swapRequestController.getSwapRequest);
router.post(
  '/:requestId/approve',
  validateParams(requestIdParamSchema),
  swapRequestController.approveSwapRequest
);
router.post(
  '/:requestId/reject',
  validateParams(requestIdParamSchema),
  swapRequestController.rejectSwapRequest
);

export default router;
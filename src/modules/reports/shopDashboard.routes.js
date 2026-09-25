import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateParams, validateQuery } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';
import { dashboardSummaryQuerySchema } from '../company/company.validation.js';
import * as shopDashboardService from './shopDashboard.service.js';

/**
 * Mounted at /api/shops/:shopId/dashboard-summary. Read-only, so - like every
 * read in this project - not behind the billing gate. VIEW_REPORTS is checked
 * in the service.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(dashboardSummaryQuerySchema),
  asyncHandler(async (req, res) => {
    res
      .status(200)
      .json(await shopDashboardService.getShopDashboard(req.actor, req.params.shopId, req.query));
  })
);

export default router;

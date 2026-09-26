import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';
import * as receiptInfoService from './receiptInfo.service.js';

/** Mounted at /api/shops/:shopId/receipt-info. Read only. */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  asyncHandler(async (req, res) => {
    res.status(200).json(await receiptInfoService.getReceiptInfo(req.actor, req.params.shopId));
  })
);

export default router;

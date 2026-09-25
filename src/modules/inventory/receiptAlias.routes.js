import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { requireActiveBillingForShop } from '../../middleware/requireActiveBillingForShop.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';
import { saveReceiptAliasesSchema } from './receiptAlias.validation.js';
import * as receiptAliasService from './receiptAlias.service.js';

/**
 * Mounted at /api/shops/:shopId/receipt-aliases. Same access shape as
 * inventory-items: owner or staff, VIEW_INVENTORY to read, MANAGE_INVENTORY to
 * write (checked in the service), writes behind the billing gate.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  asyncHandler(async (req, res) => {
    res.status(200).json(await receiptAliasService.listAliases(req.actor, req.params.shopId));
  })
);

router.post(
  '/',
  requireActiveBillingForShop,
  validateParams(shopIdOnlyParamSchema),
  validateBody(saveReceiptAliasesSchema),
  asyncHandler(async (req, res) => {
    res
      .status(200)
      .json(await receiptAliasService.saveAliases(req.actor, req.params.shopId, req.body.aliases));
  })
);

export default router;

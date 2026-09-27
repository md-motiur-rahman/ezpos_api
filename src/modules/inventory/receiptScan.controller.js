import { asyncHandler } from '../../utils/asyncHandler.js';
import * as receiptScanService from './receiptScan.service.js';

export const scanReceipt = asyncHandler(async (req, res) => {
  const parsed = await receiptScanService.scanReceipt(req.actor, req.params.shopId, req.body);
  res.status(200).json(parsed);
});

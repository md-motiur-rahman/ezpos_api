import { asyncHandler } from '../../utils/asyncHandler.js';
import * as inventoryScanService from './inventoryScan.service.js';

export const createScan = asyncHandler(async (req, res) => {
  const scan = await inventoryScanService.createScan(req.actor, req.params.shopId, req.body);
  res.status(201).json(scan);
});

export const listScans = asyncHandler(async (req, res) => {
  const scans = await inventoryScanService.listScans(req.actor, req.params.shopId);
  res.status(200).json(scans);
});

export const getScan = asyncHandler(async (req, res) => {
  const scan = await inventoryScanService.getScan(req.actor, req.params.shopId, req.params.scanId);
  res.status(200).json(scan);
});

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

export const listLatestScans = asyncHandler(async (req, res) => {
  const scans = await inventoryScanService.listLatestScans(req.actor, req.params.shopId);
  res.status(200).json(scans);
});

export const triggerPrint = asyncHandler(async (req, res) => {
  const print = await inventoryScanService.triggerPrint(
    req.actor,
    req.params.shopId,
    req.params.scanId
  );
  res.status(201).json(print);
});

export const listPrints = asyncHandler(async (req, res) => {
  const prints = await inventoryScanService.listPrints(req.actor, req.params.shopId, req.params.scanId);
  res.status(200).json(prints);
});

export const listExpiredScans = asyncHandler(async (req, res) => {
  const scans = await inventoryScanService.listExpiredScans(req.actor, req.params.shopId);
  res.status(200).json(scans);
});

export const resolveScan = asyncHandler(async (req, res) => {
  const resolution = await inventoryScanService.resolveScan(
    req.actor,
    req.params.shopId,
    req.params.scanId,
    req.body
  );
  res.status(201).json(resolution);
});

export const getResolution = asyncHandler(async (req, res) => {
  const resolution = await inventoryScanService.getResolution(
    req.actor,
    req.params.shopId,
    req.params.scanId
  );
  res.status(200).json(resolution);
});

import { asyncHandler } from '../../utils/asyncHandler.js';
import * as wastageLogService from './wastageLog.service.js';

export const createWastageLog = asyncHandler(async (req, res) => {
  const log = await wastageLogService.createWastageLog(req.actor, req.params.shopId, req.body);
  res.status(201).json(log);
});

export const listWastageLogs = asyncHandler(async (req, res) => {
  const logs = await wastageLogService.listWastageLogs(req.actor, req.params.shopId);
  res.status(200).json(logs);
});

export const getWastageLog = asyncHandler(async (req, res) => {
  const log = await wastageLogService.getWastageLog(req.actor, req.params.shopId, req.params.wastageLogId);
  res.status(200).json(log);
});
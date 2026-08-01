import { asyncHandler } from '../../utils/asyncHandler.js';
import * as attendanceService from './attendance.service.js';

export const clockIn = asyncHandler(async (req, res) => {
  const record = await attendanceService.clockIn(req.actor, req.params.shopId);
  res.status(201).json(record);
});

export const clockOut = asyncHandler(async (req, res) => {
  const record = await attendanceService.clockOut(req.actor, req.params.shopId);
  res.status(200).json(record);
});

export const listAttendance = asyncHandler(async (req, res) => {
  const records = await attendanceService.listAttendance(req.actor, req.params.shopId, req.query);
  res.status(200).json(records);
});

export const getAttendanceRecord = asyncHandler(async (req, res) => {
  const record = await attendanceService.getAttendanceRecord(
    req.actor,
    req.params.shopId,
    req.params.recordId
  );
  res.status(200).json(record);
});

export const compareAttendanceToRota = asyncHandler(async (req, res) => {
  const comparison = await attendanceService.compareAttendanceToRota(
    req.actor,
    req.params.shopId,
    req.query
  );
  res.status(200).json(comparison);
});
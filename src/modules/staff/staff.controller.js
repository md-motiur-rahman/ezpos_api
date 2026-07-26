import { asyncHandler } from '../../utils/asyncHandler.js';
import * as staffService from './staff.service.js';

export const createStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.createStaffForShop(req.user.id, req.params.shopId, req.body);
  res.status(201).json(staff);
});

export const listStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.listStaffForShop(req.user.id, req.params.shopId);
  res.status(200).json(staff);
});

export const getStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.getStaffMember(req.user.id, req.params.shopId, req.params.staffId);
  res.status(200).json(staff);
});

export const updateStaff = asyncHandler(async (req, res) => {
  const staff = await staffService.updateStaffMember(
    req.user.id,
    req.params.shopId,
    req.params.staffId,
    req.body
  );
  res.status(200).json(staff);
});

export const deactivateStaff = asyncHandler(async (req, res) => {
  await staffService.deactivateStaffMember(req.user.id, req.params.shopId, req.params.staffId);
  res.status(200).json({ message: 'Staff member deactivated.' });
});
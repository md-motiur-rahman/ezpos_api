import { asyncHandler } from '../../utils/asyncHandler.js';
import * as rotaService from './rota.service.js';

export const createShift = asyncHandler(async (req, res) => {
  const shift = await rotaService.createShift(req.actor, req.params.shopId, req.body);
  res.status(201).json(shift);
});

export const listShifts = asyncHandler(async (req, res) => {
  const shifts = await rotaService.listShifts(req.actor, req.params.shopId, req.query);
  res.status(200).json(shifts);
});

export const getShift = asyncHandler(async (req, res) => {
  const shift = await rotaService.getShift(req.actor, req.params.shopId, req.params.shiftId);
  res.status(200).json(shift);
});

export const updateShift = asyncHandler(async (req, res) => {
  const shift = await rotaService.updateShift(
    req.actor,
    req.params.shopId,
    req.params.shiftId,
    req.body
  );
  res.status(200).json(shift);
});

export const deleteShift = asyncHandler(async (req, res) => {
  await rotaService.deleteShift(req.actor, req.params.shopId, req.params.shiftId);
  res.status(200).json({ message: 'Shift removed.' });
});
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as authService from './auth.service.js';

export const getProfile = asyncHandler(async (req, res) => {
  const profile = await authService.getProfile(req.user.id);
  res.status(200).json(profile);
});

export const updateProfile = asyncHandler(async (req, res) => {
  const profile = await authService.updateProfile(req.user.id, req.body);
  res.status(200).json(profile);
});

export const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.id, req.body);
  res.status(200).json({ message: 'Password changed. Please log in again.' });
});

export const changeEmail = asyncHandler(async (req, res) => {
  await authService.initiateEmailChange(req.user.id, req.body);
  res.status(200).json({
    message: 'Check the new email address for a confirmation link.',
  });
});
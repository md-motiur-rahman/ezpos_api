import { asyncHandler } from '../../utils/asyncHandler.js';
import * as staffAuthService from './staffAuth.service.js';

export const login = asyncHandler(async (req, res) => {
  const result = await staffAuthService.login(req.body);
  res.status(200).json(result);
});

export const logout = asyncHandler(async (req, res) => {
  await staffAuthService.logout(req.body);
  res.status(200).json({ message: 'Logged out.' });
});
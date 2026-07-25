import { asyncHandler } from '../../utils/asyncHandler.js';
import * as authService from './auth.service.js';

export const register = asyncHandler(async (req, res) => {
  const user = await authService.registerUser(req.body);
  res.status(201).json({
    message: 'Account created. Check your email to verify your address.',
    user,
  });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  await authService.verifyEmail(req.body);
  res.status(200).json({ message: 'Email verified successfully.' });
});

export const resendVerification = asyncHandler(async (req, res) => {
  await authService.resendVerification(req.body);
  res.status(200).json({
    message: 'If that account exists and is unverified, a new verification email has been sent.',
  });
});
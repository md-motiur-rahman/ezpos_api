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

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  res.status(200).json(result);
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body);
  res.status(200).json(result);
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body);
  res.status(200).json({ message: 'Logged out.' });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body);
  res.status(200).json({
    message: 'If that account exists, a password reset email has been sent.',
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.status(200).json({ message: 'Password reset successfully.' });
});
import { asyncHandler } from '../../utils/asyncHandler.js';
import { AppError } from '../../utils/AppError.js';
import {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  getRefreshTokenFromRequest,
} from '../../utils/authCookies.js';
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
  const { accessToken, refreshToken, user } = await authService.login(req.body);
  setRefreshTokenCookie(res, refreshToken);
  res.status(200).json({ accessToken, user });
});

export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req);
  if (!refreshToken) {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  const result = await authService.refresh({ refreshToken });
  setRefreshTokenCookie(res, result.refreshToken);
  res.status(200).json({ accessToken: result.accessToken });
});

export const logout = asyncHandler(async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req);
  if (refreshToken) {
    await authService.logout({ refreshToken });
  }
  clearRefreshTokenCookie(res);
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

export const confirmEmailChange = asyncHandler(async (req, res) => {
  const result = await authService.confirmEmailChange(req.body);
  res.status(200).json({ message: 'Email address updated.', email: result.email });
});
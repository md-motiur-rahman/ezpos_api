import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().trim().email('Must be a valid email address'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
  fullName: z.string().trim().min(1, 'Full name is required'),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
});

export const resendVerificationSchema = z.object({
  email: z.string().trim().email('Must be a valid email address'),
});

export const loginSchema = z.object({
  email: z.string().trim().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export const logoutSchema = refreshSchema;
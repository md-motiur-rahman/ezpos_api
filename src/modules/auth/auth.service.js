import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import config from '../../config/index.js';
import { AppError } from '../../utils/AppError.js';
import { sendEmail } from '../../utils/mailer.js';
import { logger } from '../../utils/logger.js';
import { signAccessToken } from '../../utils/jwt.js';
import * as authRepository from './auth.repository.js';
import { verificationEmail, passwordResetEmail, emailChangeConfirmation, emailChangeRequestedNotice } from './auth.emailTemplates.js';

const BCRYPT_SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_CHANGE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const POSTGRES_UNIQUE_VIOLATION = '23505';

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Generates a high-entropy random token. The raw value is what goes out in
 * the email link (and is never stored); the hash is what we persist, so a
 * leaked database never exposes usable tokens.
 */
export function generateToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Shared by both email verification and password reset: generate a token,
 * replace any existing unused one of the same purpose, store the hash, and
 * email the raw value. Send failure is logged but non-fatal (see registerUser).
 */
async function issueToken(user, { purpose, ttlMs, buildEmail, recipientEmail }) {
  const { raw, hash } = generateToken();

  await authRepository.deleteUnusedTokens({ userId: user.id, purpose });
  await authRepository.createVerificationToken({
    userId: user.id,
    tokenHash: hash,
    purpose,
    expiresAt: new Date(Date.now() + ttlMs),
  });

  const { subject, html } = buildEmail(raw);
  try {
    await sendEmail({ to: recipientEmail ?? user.email, subject, html });
  } catch (err) {
    logger.error({ err, userId: user.id, purpose }, `Failed to send ${purpose} email`);
  }
}

function issueEmailVerificationToken(user) {
  return issueToken(user, {
    purpose: 'email_verification',
    ttlMs: EMAIL_VERIFICATION_TOKEN_TTL_MS,
    buildEmail: (raw) => verificationEmail(`${config.env.frontendUrl}/verify-email?token=${raw}`),
  });
}

function issuePasswordResetToken(user) {
  return issueToken(user, {
    purpose: 'password_reset',
    ttlMs: PASSWORD_RESET_TOKEN_TTL_MS,
    buildEmail: (raw) => passwordResetEmail(`${config.env.frontendUrl}/reset-password?token=${raw}`),
  });
}

export async function registerUser({ email, password, fullName }) {
  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await authRepository.createUser({ email, passwordHash, fullName });
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('An account with this email already exists', 409);
    }
    throw err;
  }

  await issueEmailVerificationToken(user);

  return { id: user.id, email: user.email, fullName: user.full_name };
}

export async function verifyEmail({ token }) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');

  const tokenRow = await authRepository.findValidToken({
    tokenHash: hash,
    purpose: 'email_verification',
  });

  if (!tokenRow) {
    throw new AppError('This verification link is invalid or has expired', 400);
  }

  await authRepository.markEmailVerified(tokenRow.user_id);
  await authRepository.markTokenUsed(tokenRow.id);
}

export async function resendVerification({ email }) {
  const user = await authRepository.findUserByEmail(email);

  // Deliberately do not reveal whether the email exists - same response
  // either way, so this endpoint can't be used to enumerate registered
  // accounts. If the account is real and unverified, an email goes out;
  // otherwise nothing happens.
  if (!user || user.email_verified_at) {
    return;
  }

  await issueEmailVerificationToken(user);
}

/** Creates + stores a new refresh token for a user, returns the raw value. */
async function issueRefreshToken(userId) {
  const { raw, hash } = generateToken();
  await authRepository.createRefreshToken({
    userId,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return raw;
}

export async function login({ email, password }) {
  const user = await authRepository.findUserByEmail(email);

  // Same generic message for "no such user" and "wrong password" - don't
  // reveal which one it was (standard login enumeration protection).
  if (!user || !(await comparePassword(password, user.password_hash))) {
    throw new AppError('Invalid email or password', 401);
  }

  // Safe to be specific here - they've already proven they know the password.
  if (!user.email_verified_at) {
    throw new AppError('Please verify your email before logging in', 403);
  }

  const accessToken = signAccessToken(user);
  const refreshToken = await issueRefreshToken(user.id);

  return { accessToken, refreshToken, user: { id: user.id, email: user.email } };
}

export async function refresh({ refreshToken }) {
  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const tokenRow = await authRepository.findValidRefreshToken(hash);

  if (!tokenRow) {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  // Rotation: this token is now spent, a new one takes its place.
  await authRepository.revokeRefreshToken(tokenRow.id);

  const user = await authRepository.findUserById(tokenRow.user_id);
  const accessToken = signAccessToken(user);
  const newRefreshToken = await issueRefreshToken(user.id);

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout({ refreshToken }) {
  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const tokenRow = await authRepository.findValidRefreshToken(hash);

  // Logging out an already-invalid/unknown token is a no-op, not an error -
  // the end state the caller wants (not logged in) is already true.
  if (tokenRow) {
    await authRepository.revokeRefreshToken(tokenRow.id);
  }
}

export async function forgotPassword({ email }) {
  const user = await authRepository.findUserByEmail(email);

  // Same enumeration protection as resendVerification in 1.1 - identical
  // response whether or not the account exists.
  if (!user) {
    return;
  }

  await issuePasswordResetToken(user);
}

export async function resetPassword({ token, newPassword }) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const tokenRow = await authRepository.findValidToken({ tokenHash: hash, purpose: 'password_reset' });

  if (!tokenRow) {
    throw new AppError('This password reset link is invalid or has expired', 400);
  }

  const passwordHash = await hashPassword(newPassword);
  await authRepository.updatePassword(tokenRow.user_id, passwordHash);
  await authRepository.markTokenUsed(tokenRow.id);
  // Any session created with the old password shouldn't survive a reset.
  await authRepository.revokeAllRefreshTokensForUser(tokenRow.user_id);
}

function toProfile(user) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    emailVerified: Boolean(user.email_verified_at),
    pendingEmail: user.pending_email ?? null,
  };
}

export async function getProfile(userId) {
  const user = await authRepository.findUserById(userId);
  return toProfile(user);
}

export async function updateProfile(userId, { fullName }) {
  const user = await authRepository.updateFullName(userId, fullName);
  return toProfile(user);
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await authRepository.findUserById(userId);

  if (!(await comparePassword(currentPassword, user.password_hash))) {
    throw new AppError('Current password is incorrect', 401);
  }

  const passwordHash = await hashPassword(newPassword);
  await authRepository.updatePassword(userId, passwordHash);
  // Same reasoning as password reset - old sessions shouldn't survive this,
  // including the one making this request; they'll need to log in again.
  await authRepository.revokeAllRefreshTokensForUser(userId);
}

export async function initiateEmailChange(userId, { currentPassword, newEmail }) {
  const user = await authRepository.findUserById(userId);

  if (!(await comparePassword(currentPassword, user.password_hash))) {
    throw new AppError('Current password is incorrect', 401);
  }

  const existing = await authRepository.findUserByEmail(newEmail);
  if (existing) {
    throw new AppError('An account with this email already exists', 409);
  }

  await authRepository.setPendingEmail(userId, newEmail);

  // Confirmation link goes to the NEW address.
  await issueToken(user, {
    purpose: 'email_change',
    ttlMs: EMAIL_CHANGE_TOKEN_TTL_MS,
    buildEmail: (raw) =>
      emailChangeConfirmation(`${config.env.frontendUrl}/confirm-email-change?token=${raw}`),
    recipientEmail: newEmail,
  });

  // Security notice goes to the OLD (current, still-active) address.
  try {
    await sendEmail({ to: user.email, ...emailChangeRequestedNotice(newEmail) });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send email-change security notice');
  }
}

export async function confirmEmailChange({ token }) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const tokenRow = await authRepository.findValidToken({ tokenHash: hash, purpose: 'email_change' });

  if (!tokenRow) {
    throw new AppError('This confirmation link is invalid or has expired', 400);
  }

  let result;
  try {
    result = await authRepository.commitEmailChange(tokenRow.user_id);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('That email address was taken by another account in the meantime', 409);
    }
    throw err;
  }

  await authRepository.markTokenUsed(tokenRow.id);
  // Identity has now genuinely changed - force re-login everywhere.
  await authRepository.revokeAllRefreshTokensForUser(tokenRow.user_id);

  return result;
}
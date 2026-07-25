import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import config from '../../config/index.js';
import { AppError } from '../../utils/AppError.js';
import { sendEmail } from '../../utils/mailer.js';
import { logger } from '../../utils/logger.js';
import * as authRepository from './auth.repository.js';
import { verificationEmail } from './auth.emailTemplates.js';
import { signAccessToken } from '../../utils/jwt.js';

const BCRYPT_SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const POSTGRES_UNIQUE_VIOLATION = '23505';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

async function issueEmailVerificationToken(user) {
  const { raw, hash } = generateToken();

  // Only one valid verification token should exist per user at a time.
  await authRepository.deleteUnusedTokens({ userId: user.id, purpose: 'email_verification' });
  await authRepository.createVerificationToken({
    userId: user.id,
    tokenHash: hash,
    purpose: 'email_verification',
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
  });

  const verifyUrl = `${config.env.frontendUrl}/verify-email?token=${raw}`;

  try {
    await sendEmail({
      to: user.email,
      subject: verificationEmail(verifyUrl).subject,
      html: verificationEmail(verifyUrl).html,
    });
  } catch (err) {
    // Non-fatal: the user account still exists and can request another
    // email via resend-verification. We don't want a flaky email provider
    // to make registration itself fail after the user row is already created.
    logger.error({ err, userId: user.id }, 'Failed to send verification email');
  }
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

  if (!user || !(await comparePassword(password, user.password_hash))) {
    throw new AppError('Invalid email or password', 401);
  }

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

  await authRepository.revokeRefreshToken(tokenRow.id);

  const user = await authRepository.findUserById(tokenRow.user_id);
  const accessToken = signAccessToken(user);
  const newRefreshToken = await issueRefreshToken(user.id);

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout({ refreshToken }) {
  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const tokenRow = await authRepository.findValidRefreshToken(hash);

  if (tokenRow) {
    await authRepository.revokeRefreshToken(tokenRow.id);
  }
}
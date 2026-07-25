import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import config from '../../config/index.js';
import { AppError } from '../../utils/AppError.js';
import { sendEmail } from '../../utils/mailer.js';
import { logger } from '../../utils/logger.js';
import * as authRepository from './auth.repository.js';
import { verificationEmail } from './auth.emailTemplates.js';

const BCRYPT_SALT_ROUNDS = 12;
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const POSTGRES_UNIQUE_VIOLATION = '23505';

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
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
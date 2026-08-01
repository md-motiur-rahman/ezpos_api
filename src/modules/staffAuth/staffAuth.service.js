import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppError } from '../../utils/AppError.js';
import { generateToken } from '../../utils/token.js';
import { isBillingLocked } from '../billing/billing.access.js';
import * as staffAuthRepository from './staffAuth.repository.js';

export async function login({ shopId, staffIdCode, pin }) {
  const context = await staffAuthRepository.findLoginContext(shopId, staffIdCode);

  // Same generic message for "no such staff ID" and "wrong PIN" - don't
  // reveal which one it was (same enumeration-protection pattern as owner
  // login in auth.service.js).
  if (!context || !(await bcrypt.compare(pin, context.pin_hash))) {
    throw new AppError('Invalid staff ID or PIN', 401);
  }

  if (
    isBillingLocked({
      subscription_status: context.subscription_status,
      grace_period_ends_at: context.grace_period_ends_at,
    })
  ) {
    throw new AppError(
      'Shop access is paused because a subscription payment failed. Contact the owner to restore access.',
      402
    );
  }

  const { raw, hash } = generateToken();
  await staffAuthRepository.createSession(context.id, hash);

  return {
    sessionToken: raw,
    staff: {
      id: context.id,
      fullName: context.full_name,
      role: context.role,
      shopId: context.shop_id,
    },
  };
}

export async function logout({ sessionToken }) {
  const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  await staffAuthRepository.revokeSession(tokenHash);
}
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppError } from '../../utils/AppError.js';
import { generateToken } from '../../utils/token.js';
import { isBillingLocked } from '../billing/billing.access.js';
import * as staffAuthRepository from './staffAuth.repository.js';

/**
 * No `shopId` parameter - reversed deliberately, not a leftover from an
 * earlier draft (`staffLoginSchema`'s own doc in `staffAuth.validation.js`
 * explains the same reversal from the request-contract side). A login
 * screen with no shop context of its own now works by trying every shop
 * whose `staff_id_code` matches this one, and letting the PIN itself be the
 * disambiguator: `staff_id_code` is only unique PER SHOP, so the code alone
 * cannot resolve a shop, but (code, PIN) together practically always can -
 * both are independently cryptographically random 8-digit values
 * (`crypto.randomInt`, never attacker-settable or guessable - see
 * `staff.service.js`'s `generateEightDigitCode`), so two DIFFERENT staff
 * members at two DIFFERENT shops both matching is a ~1-in-10^16 coincidence
 * by pure chance, never something an attacker can engineer.
 *
 * EVERY candidate is checked, not just until the first match (confirmed
 * directly, revising this function's earlier "stop at the first match"
 * behavior once CodeRabbit flagged it) - the repository query defines no
 * order, so "first match" was an ARBITRARY row, not a deliberate choice
 * between two real staff members. If the ~1-in-10^16 coincidence ever did
 * happen, more than one candidate now matches, and the login is refused
 * rather than silently granting a session at whichever shop happened to
 * come back first. This trades that vanishing collision risk for an
 * equally vanishing one in the other direction (both real staff members
 * momentarily locked out until an admin regenerates one of the colliding
 * credentials) - accepted deliberately, since "silently authenticate as
 * the wrong shop's staff member" is the worse failure mode of the two.
 */
export async function login({ staffIdCode, pin }) {
  const candidates = await staffAuthRepository.findLoginContextsByStaffIdCode(staffIdCode);

  const matches = [];
  for (const candidate of candidates) {
    if (await bcrypt.compare(pin, candidate.pin_hash)) {
      matches.push(candidate);
    }
  }

  // Same generic message whether the code matched nothing, nowhere, the PIN
  // was simply wrong everywhere it did, OR more than one context matched -
  // don't reveal which (same enumeration-protection pattern as owner login
  // in auth.service.js, now also covering the ambiguous-match case rather
  // than only the zero-match one).
  if (matches.length !== 1) {
    throw new AppError('Invalid staff ID or PIN', 401);
  }
  const matched = matches[0];

  if (
    isBillingLocked({
      subscription_status: matched.subscription_status,
      grace_period_ends_at: matched.grace_period_ends_at,
    })
  ) {
    throw new AppError(
      'Shop access is paused because a subscription payment failed. Contact the owner to restore access.',
      402
    );
  }

  const { raw, hash } = generateToken();
  await staffAuthRepository.createSession(matched.id, hash);

  return {
    sessionToken: raw,
    staff: {
      id: matched.id,
      fullName: matched.full_name,
      role: matched.role,
      shopId: matched.shop_id,
    },
  };
}

export async function logout({ sessionToken }) {
  const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
  await staffAuthRepository.revokeSession(tokenHash);
}
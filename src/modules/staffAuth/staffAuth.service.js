import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppError } from '../../utils/AppError.js';
import { generateToken } from '../../utils/token.js';
import { withTransaction } from '../../db/pool.js';
import { isBillingLocked } from '../billing/billing.access.js';
import * as staffAuthRepository from './staffAuth.repository.js';

// Matches staff.service.js's own PIN_SALT_ROUNDS exactly - that module
// hashes a PIN once, at creation; this one is the only other place a PIN is
// ever hashed, so the cost factor has to agree or a staff member's PIN
// would get measurably weaker (or slower to check) depending on which path
// last touched it. Duplicated rather than imported: these two modules
// otherwise share no dependency in either direction, and a two-line
// constant isn't worth inventing a shared module for.
const PIN_SALT_ROUNDS = 12;

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

/**
 * Self-service PIN change - a staff member changing their OWN pin from an
 * already-authenticated session (`staffId` comes from `req.staff.id`,
 * verified by `requireStaffAuth` before this ever runs, never from the
 * request body). Mirrors `auth.service.js`'s own `changePassword` exactly:
 * re-check the current credential first (never trust that holding a valid
 * SESSION proves the PIN itself, the same reasoning a password change
 * re-asks for the current password even though the request is already
 * authenticated), then revoke every session for this staff member -
 * including the one making this call - so nothing keeps working on the
 * old PIN once it's no longer valid.
 *
 * **No enumeration risk to guard here the way login has** - unlike login
 * (which must not reveal whether a staffIdCode exists at all), this staff
 * member is already identified by an authenticated session, so a distinct
 * 401 for "current PIN wrong" is exactly the right signal, not an
 * information leak.
 *
 * **The PIN update and the session revocation run in one transaction**
 * (CodeRabbit finding) - they used to be two separate pool writes, so a
 * failure of the second (revocation) after the first (the PIN hash) had
 * already committed would return an error while leaving the PIN actually
 * changed AND every old session, including one an attacker who obtained
 * the old PIN might already be holding, still valid. `db/pool.js`'s
 * `withTransaction` (9.5's payment-race fix) is reused unchanged: both
 * repository calls take its `client` so either both commit or neither
 * does.
 */
export async function changePin(staffId, { currentPin, newPin }) {
  const staff = await staffAuthRepository.findPinHashById(staffId);
  if (!staff) {
    // Should be unreachable in practice - `requireStaffAuth`'s own join
    // already excludes a deactivated staff member's session from ever
    // resolving. Guarded anyway rather than letting a null `pin_hash`
    // reach bcrypt.compare below.
    throw new AppError('Staff not found', 404);
  }

  if (!(await bcrypt.compare(currentPin, staff.pin_hash))) {
    throw new AppError('Current PIN is incorrect', 401);
  }

  if (newPin === currentPin) {
    throw new AppError('New PIN must be different from your current PIN', 400);
  }

  const pinHash = await bcrypt.hash(newPin, PIN_SALT_ROUNDS);
  await withTransaction(async (client) => {
    await staffAuthRepository.updatePinHash(staffId, pinHash, client);
    await staffAuthRepository.revokeAllSessionsForStaff(staffId, client);
  });
}
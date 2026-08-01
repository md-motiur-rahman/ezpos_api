import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppError } from '../../utils/AppError.js';
import { ROLE_RANK, PERMISSIONS, hasEffectivePermission } from './permissions.js';
import { resolveActorAuthority } from './actorAuthority.js';
import * as staffRepository from './staff.repository.js';

const PIN_SALT_ROUNDS = 12;
const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_ID_CODE_ATTEMPTS = 5;

/**
 * 8 digits, zero-padded, using a cryptographically random number rather than
 * Math.random() - these identify and authenticate a real staff member.
 */
function generateEightDigitCode() {
  return crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
}

function toResponse(staff) {
  return {
    id: staff.id,
    shopId: staff.shop_id,
    fullName: staff.full_name,
    role: staff.role,
    staffIdCode: staff.staff_id_code,
    createdAt: staff.created_at,
    updatedAt: staff.updated_at,
  };
}

/**
 * The single rule that reproduces the whole spec: a staff member can only
 * manage someone STRICTLY below their own rank. "Manager cannot create
 * another Manager" falls out of this automatically (equal rank fails the
 * strict inequality) - no special-casing needed. Self-management is
 * likewise blocked for free: nobody outranks themselves.
 */
function assertOutranks(actorRole, targetRole, actionVerb) {
  if (ROLE_RANK[actorRole] <= ROLE_RANK[targetRole]) {
    throw new AppError(`You cannot ${actionVerb} a staff member at your rank or above`, 403);
  }
}

export async function createStaffForShop(actor, shopId, { fullName, role }) {
  const { role: actorRole, activeOverridePermissions: actorOverrides } = await resolveActorAuthority(
    actor,
    shopId
  );

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.MANAGE_STAFF)) {
    throw new AppError('You do not have permission to manage staff', 403);
  }
  assertOutranks(actorRole, role, 'create');

  const rawPin = generateEightDigitCode();
  const pinHash = await bcrypt.hash(rawPin, PIN_SALT_ROUNDS);

  let staff;
  for (let attempt = 1; ; attempt += 1) {
    const staffIdCode = generateEightDigitCode();
    try {
      staff = await staffRepository.createStaff(shopId, {
        fullName,
        role,
        staffIdCode,
        pinHash,
      });
      break;
    } catch (err) {
      // A collision on an 8-digit code is astronomically unlikely - this is
      // just a defensive retry, not something expected to actually fire.
      if (err.code === POSTGRES_UNIQUE_VIOLATION && attempt < MAX_ID_CODE_ATTEMPTS) {
        continue;
      }
      if (err.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new AppError('Failed to generate a unique staff ID - please try again', 500);
      }
      throw err;
    }
  }

  return {
    ...toResponse(staff),
    // One-time reveal, same principle as verification tokens - the raw PIN
    // is never retrievable again after this response.
    pin: rawPin,
  };
}

export async function listStaffForShop(actor, shopId) {
  await resolveActorAuthority(actor, shopId); // scope check only - reads stay open
  const staff = await staffRepository.listActiveStaffForShop(shopId);
  return staff.map(toResponse);
}

async function getTargetStaffInScope(actor, shopId, staffId) {
  await resolveActorAuthority(actor, shopId); // scope check only - reads stay open
  const staff = await staffRepository.findActiveStaffByIdForShop(staffId, shopId);
  if (!staff) {
    throw new AppError('Staff member not found', 404);
  }
  return staff;
}

export async function getStaffMember(actor, shopId, staffId) {
  const staff = await getTargetStaffInScope(actor, shopId, staffId);
  return toResponse(staff);
}

export async function updateStaffMember(actor, shopId, staffId, data) {
  const { role: actorRole, activeOverridePermissions: actorOverrides } = await resolveActorAuthority(
    actor,
    shopId
  );
  const targetStaff = await staffRepository.findActiveStaffByIdForShop(staffId, shopId);
  if (!targetStaff) {
    throw new AppError('Staff member not found', 404);
  }

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.MANAGE_STAFF)) {
    throw new AppError('You do not have permission to manage staff', 403);
  }
  assertOutranks(actorRole, targetStaff.role, 'update');
  // Changing role is itself bound by the same ceiling - promoting someone to
  // the actor's own rank or above via an edit is blocked the same way
  // creating them at that rank would be.
  if (data.role) {
    assertOutranks(actorRole, data.role, 'promote a staff member to');
  }

  const updated = await staffRepository.updateStaff(targetStaff.id, data);
  return toResponse(updated);
}

export async function deactivateStaffMember(actor, shopId, staffId) {
  const { role: actorRole, activeOverridePermissions: actorOverrides } = await resolveActorAuthority(
    actor,
    shopId
  );
  const targetStaff = await staffRepository.findActiveStaffByIdForShop(staffId, shopId);
  if (!targetStaff) {
    throw new AppError('Staff member not found', 404);
  }

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.MANAGE_STAFF)) {
    throw new AppError('You do not have permission to manage staff', 403);
  }
  // Self-deactivation is blocked for free here: an actor's own rank can
  // never be strictly greater than their own rank.
  assertOutranks(actorRole, targetStaff.role, 'deactivate');

  await staffRepository.softDeleteStaff(targetStaff.id);
  // Any active session for this staff member is invalidated automatically on
  // their next request - requireStaffAuth's session lookup (4.3) requires
  // staff.deleted_at IS NULL, no explicit revocation needed here.
}
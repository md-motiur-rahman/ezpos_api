import { AppError } from '../../utils/AppError.js';
import { ROLES, ROLE_RANK, PERMISSIONS, hasEffectivePermission } from './permissions.js';
import * as staffRepository from './staff.repository.js';
import * as companyRepository from '../company/company.repository.js';
import * as shopRepository from '../shop/shop.repository.js';
import * as staffPermissionRepository from './staffPermission.repository.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function toResponse(override) {
  return {
    id: override.id,
    staffId: override.staff_id,
    permission: override.permission,
    grantedBy: override.granted_by,
    createdAt: override.created_at,
  };
}

async function getTargetStaffOrThrow(staffId) {
  const staff = await staffRepository.findActiveStaffById(staffId);
  if (!staff) {
    throw new AppError('Staff member not found', 404);
  }
  return staff;
}

/**
 * Resolves the calling actor's role + active overrides for authorization
 * purposes, after confirming they actually have authority over the target's
 * shop at all - not found/out of scope both simply 404, same convention as
 * every other ownership check in this project.
 *
 * The Owner is treated uniformly as ROLES.OWNER with no overrides needed:
 * roleHasPermission's Owner bypass (4.1) already makes every subsequent
 * check pass for them without special-casing anything below this point.
 */
async function resolveActorAuthority(actor, targetShopId) {
  if (actor.type === 'owner') {
    const company = await companyRepository.findActiveCompanyByOwner(actor.id);
    const shop = company
      ? await shopRepository.findActiveShopByIdForCompany(targetShopId, company.id)
      : null;
    if (!shop) {
      throw new AppError('Staff member not found', 404);
    }
    return { role: ROLES.OWNER, activeOverridePermissions: [] };
  }

  // actor.type === 'staff' - can only manage staff within their own shop.
  if (actor.shopId !== targetShopId) {
    throw new AppError('Staff member not found', 404);
  }
  const activeOverridePermissions = await staffPermissionRepository.listActivePermissionsForStaff(
    actor.id
  );
  return { role: actor.role, activeOverridePermissions };
}

export async function grantPermission(actor, targetStaffId, permission) {
  const targetStaff = await getTargetStaffOrThrow(targetStaffId);
  const { role: actorRole, activeOverridePermissions: actorOverrides } =
    await resolveActorAuthority(actor, targetStaff.shop_id);

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.GRANT_PERMISSIONS)) {
    throw new AppError('You do not have permission to grant permissions', 403);
  }
  if (ROLE_RANK[actorRole] <= ROLE_RANK[targetStaff.role]) {
    throw new AppError('You cannot manage permissions for a staff member at your rank or above', 403);
  }
  if (!hasEffectivePermission(actorRole, actorOverrides, permission)) {
    throw new AppError('You cannot grant a permission you do not have yourself', 403);
  }

  let override;
  try {
    override = await staffPermissionRepository.createOverride(
      targetStaff.id,
      permission,
      actor.type === 'staff' ? actor.id : null
    );
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('That permission is already granted to this staff member', 409);
    }
    throw err;
  }

  return toResponse(override);
}

export async function revokePermission(actor, targetStaffId, permission) {
  const targetStaff = await getTargetStaffOrThrow(targetStaffId);
  const { role: actorRole, activeOverridePermissions: actorOverrides } =
    await resolveActorAuthority(actor, targetStaff.shop_id);

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.GRANT_PERMISSIONS)) {
    throw new AppError('You do not have permission to revoke permissions', 403);
  }
  if (ROLE_RANK[actorRole] <= ROLE_RANK[targetStaff.role]) {
    throw new AppError('You cannot manage permissions for a staff member at your rank or above', 403);
  }

  const existing = await staffPermissionRepository.findActiveOverride(targetStaff.id, permission);
  if (!existing) {
    throw new AppError('That permission is not currently granted to this staff member', 404);
  }
  await staffPermissionRepository.revokeOverride(existing.id);
}

/**
 * Read access is more permissive than grant/revoke, matching the pattern set
 * by billing lockout (3.6): being in scope is enough to VIEW, only mutating
 * requires grant_permissions specifically.
 */
export async function listEffectivePermissions(actor, targetStaffId) {
  const targetStaff = await getTargetStaffOrThrow(targetStaffId);
  await resolveActorAuthority(actor, targetStaff.shop_id); // scope check only

  const targetOverrides = await staffPermissionRepository.listActivePermissionsForStaff(
    targetStaff.id
  );
  const permissions = Object.values(PERMISSIONS).filter((permission) =>
    hasEffectivePermission(targetStaff.role, targetOverrides, permission)
  );

  return { staffId: targetStaff.id, role: targetStaff.role, permissions };
}
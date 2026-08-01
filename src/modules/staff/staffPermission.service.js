import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS, ROLE_RANK, hasEffectivePermission } from './permissions.js';
import { resolveActorAuthority } from './actorAuthority.js';
import * as staffRepository from './staff.repository.js';
import * as staffPermissionRepository from './staffPermission.repository.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function toResponse(override) {
  return {
    id: override.id,
    staffId: override.staff_id,
    permission: override.permission,
    grantedByType: override.granted_by_type,
    grantedById: override.granted_by_id,
    createdAt: override.created_at,
  };
}

function toAuditLogEntry(row) {
  return {
    id: row.id,
    staffId: row.staff_id,
    permission: row.permission,
    grantedByType: row.granted_by_type,
    grantedById: row.granted_by_id,
    grantedAt: row.created_at,
    revokedByType: row.revoked_by_type,
    revokedById: row.revoked_by_id,
    revokedAt: row.revoked_at,
  };
}

async function getTargetStaffOrThrow(staffId) {
  const staff = await staffRepository.findActiveStaffById(staffId);
  if (!staff) {
    throw new AppError('Staff member not found', 404);
  }
  return staff;
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
      actor.type,
      actor.id
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
  await staffPermissionRepository.revokeOverride(existing.id, actor.type, actor.id);
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

/**
 * Requires grant_permissions - the same gate as actually performing a
 * grant/revoke, on the reasoning that whoever can act should be able to
 * audit. Scoped directly to a shop (not derived from a target staff member -
 * there isn't one single target for a shop-wide history).
 */
export async function listAuditLog(actor, shopId, limit) {
  const { role: actorRole, activeOverridePermissions: actorOverrides } = await resolveActorAuthority(
    actor,
    shopId
  );

  if (!hasEffectivePermission(actorRole, actorOverrides, PERMISSIONS.GRANT_PERMISSIONS)) {
    throw new AppError('You do not have permission to view the permission audit log', 403);
  }

  const rows = await staffPermissionRepository.listAuditLogForShop(shopId, limit);
  return rows.map(toAuditLogEntry);
}
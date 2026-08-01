import { AppError } from '../../utils/AppError.js';
import { ROLES } from './permissions.js';
import * as companyRepository from '../company/company.repository.js';
import * as shopRepository from '../shop/shop.repository.js';
import * as staffPermissionRepository from './staffPermission.repository.js';

/**
 * Resolves the calling actor's role + active permission overrides for
 * authorization purposes, after confirming they actually have authority over
 * the given shop at all - not found/out of scope both simply 404, same
 * convention as every other ownership check in this project.
 *
 * The Owner is treated uniformly as ROLES.OWNER with no overrides needed:
 * roleHasPermission's Owner bypass (4.1) already makes every subsequent
 * check pass for them without special-casing anything below this point.
 *
 * Shared by staffPermission.service.js (4.4) and staff.service.js (4.5) -
 * both need the identical "who is allowed to touch this shop's staff" logic.
 * Originally written inline in 4.4, extracted here once a second module
 * needed the exact same code rather than a near-duplicate.
 */
export async function resolveActorAuthority(actor, shopId) {
  if (actor.type === 'owner') {
    const company = await companyRepository.findActiveCompanyByOwner(actor.id);
    const shop = company
      ? await shopRepository.findActiveShopByIdForCompany(shopId, company.id)
      : null;
    if (!shop) {
      throw new AppError('Staff member not found', 404);
    }
    return { role: ROLES.OWNER, activeOverridePermissions: [] };
  }

  // actor.type === 'staff' - can only act within their own shop.
  if (actor.shopId !== shopId) {
    throw new AppError('Staff member not found', 404);
  }
  const activeOverridePermissions = await staffPermissionRepository.listActivePermissionsForStaff(
    actor.id
  );
  return { role: actor.role, activeOverridePermissions };
}
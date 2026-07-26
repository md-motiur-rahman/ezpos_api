/**
 * Roles and permissions are code constants, not database tables - both are
 * closed, platform-defined sets tied directly to code paths (a new permission
 * only does anything once something actually checks for it). Same precedent
 * as business_type, addon_type, subscription_status elsewhere in this project.
 *
 * This file has no HTTP endpoint and touches no database - it's the shared
 * foundation 4.2 (staff table), 4.3 (PIN auth), 4.4 (permission overrides) and
 * 4.5 (hierarchy enforcement) all build on.
 */

export const ROLES = Object.freeze({
  OWNER: 'owner',
  MANAGER: 'manager',
  SHIFT_MANAGER: 'shift_manager',
  SERVER: 'server',
  CHEF: 'chef',
});

export const PERMISSIONS = Object.freeze({
  VIEW_INVENTORY: 'view_inventory',
  MANAGE_INVENTORY: 'manage_inventory',
  REQUEST_STOCK_ORDER: 'request_stock_order',
  MANAGE_STOCK_ORDERS: 'manage_stock_orders',
  MANAGE_STAFF: 'manage_staff',
  ACCESS_TILL: 'access_till',
  PERFORM_HEALTH_SAFETY: 'perform_health_safety',
  GRANT_PERMISSIONS: 'grant_permissions',
  VIEW_REPORTS: 'view_reports',
  MANAGE_ROTA: 'manage_rota',
});

/**
 * Higher outranks lower. Used by Module 4.5 (hierarchy enforcement) - e.g. a
 * permission can only be revoked by someone outranking who it was granted to.
 * Server and Chef are deliberately equal - neither outranks the other.
 *
 * "Who can create a Manager" is NOT modelled here as a permission or a rank
 * comparison - it's a fixed structural rule ("nobody but the Owner creates a
 * Manager"), which 4.5 implements directly rather than deriving from rank.
 */
export const ROLE_RANK = Object.freeze({
  [ROLES.OWNER]: 4,
  [ROLES.MANAGER]: 3,
  [ROLES.SHIFT_MANAGER]: 2,
  [ROLES.SERVER]: 1,
  [ROLES.CHEF]: 1,
});

/**
 * Default permissions per role. The Owner entry is for documentation/display
 * purposes only (e.g. a future "what can this role do" UI) - roleHasPermission
 * below never actually consults it, since the Owner bypasses the permission
 * system entirely.
 */
export const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: Object.freeze(Object.values(PERMISSIONS)),

  // "manage inventory, add staff, create Shift Managers, use till, perform
  // H&S" + grants permissions to others by default.
  [ROLES.MANAGER]: Object.freeze([
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY,
    PERMISSIONS.MANAGE_STOCK_ORDERS,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.ACCESS_TILL,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    PERMISSIONS.GRANT_PERMISSIONS,
  ]),

  // Manager-level abilities are earned only via 4.4's override system, never
  // granted by default just for holding this role.
  [ROLES.SHIFT_MANAGER]: Object.freeze([
    PERMISSIONS.ACCESS_TILL,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
  ]),

  [ROLES.SERVER]: Object.freeze([PERMISSIONS.ACCESS_TILL, PERMISSIONS.PERFORM_HEALTH_SAFETY]),

  // Can see stock and ask for more, but not touch levels directly or place
  // orders unapproved. No till access by default.
  [ROLES.CHEF]: Object.freeze([
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.REQUEST_STOCK_ORDER,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
  ]),
});

/**
 * Whether a role has a given permission BY DEFAULT (before any per-staff
 * override from 4.4 is applied). The Owner always returns true, for any
 * permission - including one that doesn't exist - since the Owner is never
 * blocked by this system at all.
 */
export function roleHasPermission(role, permission) {
  if (role === ROLES.OWNER) {
    return true;
  }

  const defaults = ROLE_DEFAULT_PERMISSIONS[role];
  return defaults ? defaults.includes(permission) : false;
}
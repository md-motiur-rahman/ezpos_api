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
  MANAGE_MENU: 'manage_menu',
  // 9.3 - separate from ACCESS_TILL on purpose: not every till user should
  // be able to discount an order, confirmed directly.
  APPLY_DISCOUNT: 'apply_discount',
  // 10.1 - watching the kitchen display. Deliberately NOT reusing
  // ACCESS_TILL: the Chef is exactly who needs the KDS and is the one role
  // that has never had till access (see ROLE_DEFAULT_PERMISSIONS below), so
  // gating the kitchen screen on the till permission would lock out its
  // primary user. It is the mirror image of the front-of-house/kitchen split
  // ACCESS_TILL already draws, not a duplicate of it.
  VIEW_KDS: 'view_kds',
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
  // H&S, manage rota, manage the shop's menu" + grants permissions to
  // others by default.
  [ROLES.MANAGER]: Object.freeze([
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY,
    PERMISSIONS.MANAGE_STOCK_ORDERS,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.ACCESS_TILL,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    PERMISSIONS.GRANT_PERMISSIONS,
    PERMISSIONS.MANAGE_ROTA,
    PERMISSIONS.MANAGE_MENU,
    PERMISSIONS.APPLY_DISCOUNT,
    // 10.1 - a Manager runs the floor and needs to see the kitchen queue.
    PERMISSIONS.VIEW_KDS,
  ]),

  // Manager-level abilities (including manage_rota and manage_menu) are
  // earned only via 4.4's override system, never granted by default just
  // for holding this role - APPLY_DISCOUNT (9.3) is a deliberate exception,
  // confirmed directly: discounting is an on-the-floor discretion call a
  // Shift Manager needs in the moment, not something worth gating behind a
  // manual grant every single shop would otherwise have to set up.
  [ROLES.SHIFT_MANAGER]: Object.freeze([
    PERMISSIONS.ACCESS_TILL,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    PERMISSIONS.APPLY_DISCOUNT,
    // 10.1 - same reasoning as APPLY_DISCOUNT above: a Shift Manager is
    // running the floor in the moment and needs the kitchen queue without
    // waiting for a manual grant every shop would otherwise have to set up.
    PERMISSIONS.VIEW_KDS,
  ]),

  [ROLES.SERVER]: Object.freeze([PERMISSIONS.ACCESS_TILL, PERMISSIONS.PERFORM_HEALTH_SAFETY]),

  // Can see stock and ask for more, but not touch levels directly or place
  // orders unapproved. No till access by default.
  [ROLES.CHEF]: Object.freeze([
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.REQUEST_STOCK_ORDER,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    // 10.1 - the KDS's primary user. The Chef has no till access and never
    // has, which is exactly why VIEW_KDS is its own permission rather than
    // part of ACCESS_TILL.
    PERMISSIONS.VIEW_KDS,
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

/**
 * Whether a role has a permission EITHER by default OR via an active
 * per-staff override (Module 4.4). Overrides only ADD to the default set -
 * they can't strip away a role's own defaults for one specific person; that
 * would be a materially different (deny-list) feature, out of scope here.
 */
export function hasEffectivePermission(role, activeOverridePermissions, permission) {
  if (roleHasPermission(role, permission)) {
    return true;
  }
  return activeOverridePermissions.includes(permission);
}
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, PERMISSIONS, ROLE_RANK, roleHasPermission } from '../../src/modules/staff/permissions.js';

// --- Owner bypasses everything ---

test('Owner has every real permission', () => {
  for (const permission of Object.values(PERMISSIONS)) {
    assert.equal(roleHasPermission(ROLES.OWNER, permission), true);
  }
});

test('Owner returns true even for a made-up permission', () => {
  assert.equal(roleHasPermission(ROLES.OWNER, 'time_travel'), true);
});

// --- Manager defaults ---

test('Manager has inventory, stock orders, staff, till, H&S, and granting permissions', () => {
  const expected = [
    PERMISSIONS.VIEW_INVENTORY,
    PERMISSIONS.MANAGE_INVENTORY,
    PERMISSIONS.MANAGE_STOCK_ORDERS,
    PERMISSIONS.MANAGE_STAFF,
    PERMISSIONS.ACCESS_TILL,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    PERMISSIONS.GRANT_PERMISSIONS,
  ];
  for (const permission of expected) {
    assert.equal(roleHasPermission(ROLES.MANAGER, permission), true);
  }
});

test('Manager does not have request_stock_order (they place orders directly, not request them)', () => {
  assert.equal(roleHasPermission(ROLES.MANAGER, PERMISSIONS.REQUEST_STOCK_ORDER), false);
});

// --- Shift Manager defaults (baseline only - manager abilities come from 4.4 overrides) ---

test('Shift Manager defaults to only till and H&S', () => {
  assert.equal(roleHasPermission(ROLES.SHIFT_MANAGER, PERMISSIONS.ACCESS_TILL), true);
  assert.equal(roleHasPermission(ROLES.SHIFT_MANAGER, PERMISSIONS.PERFORM_HEALTH_SAFETY), true);
});

test('Shift Manager does not have manager-level permissions by default', () => {
  assert.equal(roleHasPermission(ROLES.SHIFT_MANAGER, PERMISSIONS.MANAGE_INVENTORY), false);
  assert.equal(roleHasPermission(ROLES.SHIFT_MANAGER, PERMISSIONS.MANAGE_STAFF), false);
  assert.equal(roleHasPermission(ROLES.SHIFT_MANAGER, PERMISSIONS.GRANT_PERMISSIONS), false);
});

// --- Server defaults ---

test('Server has only till and H&S', () => {
  assert.equal(roleHasPermission(ROLES.SERVER, PERMISSIONS.ACCESS_TILL), true);
  assert.equal(roleHasPermission(ROLES.SERVER, PERMISSIONS.PERFORM_HEALTH_SAFETY), true);
  assert.equal(roleHasPermission(ROLES.SERVER, PERMISSIONS.VIEW_INVENTORY), false);
  assert.equal(roleHasPermission(ROLES.SERVER, PERMISSIONS.MANAGE_INVENTORY), false);
});

// --- Chef defaults ---

test('Chef can view inventory and request stock, but cannot manage inventory or orders', () => {
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.VIEW_INVENTORY), true);
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.REQUEST_STOCK_ORDER), true);
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.MANAGE_INVENTORY), false);
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.MANAGE_STOCK_ORDERS), false);
});

test('Chef has H&S but no till access by default', () => {
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.PERFORM_HEALTH_SAFETY), true);
  assert.equal(roleHasPermission(ROLES.CHEF, PERMISSIONS.ACCESS_TILL), false);
});

// --- Unknown role / permission ---

test('an unrecognised role has no permissions', () => {
  assert.equal(roleHasPermission('regional_manager', PERMISSIONS.ACCESS_TILL), false);
});

// --- Rank ordering ---

test('rank ordering is Owner > Manager > Shift Manager > Server = Chef', () => {
  assert.ok(ROLE_RANK[ROLES.OWNER] > ROLE_RANK[ROLES.MANAGER]);
  assert.ok(ROLE_RANK[ROLES.MANAGER] > ROLE_RANK[ROLES.SHIFT_MANAGER]);
  assert.ok(ROLE_RANK[ROLES.SHIFT_MANAGER] > ROLE_RANK[ROLES.SERVER]);
  assert.equal(ROLE_RANK[ROLES.SERVER], ROLE_RANK[ROLES.CHEF]);
});
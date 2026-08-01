import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSessionExpired } from '../../src/modules/staffAuth/staffSession.access.js';

test('a session active just now is not expired', () => {
  assert.equal(isSessionExpired({ last_active_at: new Date() }), false);
});

test('a session active 59 minutes ago is not expired', () => {
  const lastActiveAt = new Date(Date.now() - 59 * 60 * 1000);
  assert.equal(isSessionExpired({ last_active_at: lastActiveAt }), false);
});

test('a session active 61 minutes ago is expired', () => {
  const lastActiveAt = new Date(Date.now() - 61 * 60 * 1000);
  assert.equal(isSessionExpired({ last_active_at: lastActiveAt }), true);
});
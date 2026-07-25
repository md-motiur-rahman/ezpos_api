import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signAccessToken, verifyAccessToken } from '../../src/utils/jwt.js';

test('signAccessToken + verifyAccessToken round-trip correctly', () => {
  const user = { id: 'user-123', email: 'test@example.com' };
  const token = signAccessToken(user);
  const payload = verifyAccessToken(token);

  assert.equal(payload.sub, user.id);
  assert.equal(payload.email, user.email);
});

test('verifyAccessToken throws on a garbage token', () => {
  assert.throws(() => verifyAccessToken('not.a.real.token'));
});
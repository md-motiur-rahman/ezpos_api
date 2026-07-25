import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireAuth } from '../../src/middleware/requireAuth.js';
import { signAccessToken } from '../../src/utils/jwt.js';

test('requireAuth attaches req.user for a valid Bearer token', () => {
  const token = signAccessToken({ id: 'user-1', email: 'a@example.com' });
  const req = { headers: { authorization: `Bearer ${token}` } };
  let calledWithError;

  requireAuth(req, {}, (err) => {
    calledWithError = err;
  });

  assert.equal(calledWithError, undefined);
  assert.equal(req.user.id, 'user-1');
});

test('requireAuth rejects a missing Authorization header', () => {
  const req = { headers: {} };
  let calledWithError;

  requireAuth(req, {}, (err) => {
    calledWithError = err;
  });

  assert.equal(calledWithError.statusCode, 401);
});

test('requireAuth rejects a malformed token', () => {
  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  let calledWithError;

  requireAuth(req, {}, (err) => {
    calledWithError = err;
  });

  assert.equal(calledWithError.statusCode, 401);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateToken } from '../../src/modules/auth/auth.service.js';

test('generateToken returns a raw token and its sha256 hash', () => {
  const { raw, hash } = generateToken();

  assert.equal(typeof raw, 'string');
  assert.equal(raw.length, 64); // 32 random bytes as hex
  assert.equal(hash, crypto.createHash('sha256').update(raw).digest('hex'));
});

test('generateToken produces a different token every call', () => {
  const first = generateToken();
  const second = generateToken();

  assert.notEqual(first.raw, second.raw);
});
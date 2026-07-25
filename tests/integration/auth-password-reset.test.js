import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser(email) {
  const passwordHash = await bcrypt.hash('originalpassword123', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test User', now()) RETURNING id`,
    [email, passwordHash]
  );
  return rows[0].id;
}

async function insertResetToken(userId, { expiresAt, usedAt = null }) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query(
    `INSERT INTO verification_tokens (user_id, token_hash, purpose, expires_at, used_at)
     VALUES ($1, $2, 'password_reset', $3, $4)`,
    [userId, hash, expiresAt, usedAt]
  );
  return raw;
}

// --- POST /api/auth/forgot-password ---

test('POST /api/auth/forgot-password issues a password_reset token for an existing user', async () => {
  const email = uniqueEmail('forgot');
  const userId = await insertUser(email);

  const res = await request(app).post('/api/auth/forgot-password').send({ email });

  assert.equal(res.status, 200);
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM verification_tokens
     WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL`,
    [userId]
  );
  assert.equal(rows[0].count, 1);
});

test('POST /api/auth/forgot-password responds identically for a nonexistent email', async () => {
  const res = await request(app)
    .post('/api/auth/forgot-password')
    .send({ email: uniqueEmail('nonexistent') });

  assert.equal(res.status, 200);
});

// --- POST /api/auth/reset-password ---

test('POST /api/auth/reset-password updates the password and revokes existing sessions', async () => {
  const email = uniqueEmail('reset-ok');
  const userId = await insertUser(email);
  const raw = await insertResetToken(userId, { expiresAt: new Date(Date.now() + 60_000) });

  // Give the user an active session that should get revoked by the reset.
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'originalpassword123' });
  const oldRefreshToken = loginRes.body.refreshToken;

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: raw, newPassword: 'brandnewpassword456' });
  assert.equal(res.status, 200);

  // Old password no longer works.
  const oldLoginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'originalpassword123' });
  assert.equal(oldLoginRes.status, 401);

  // New password works.
  const newLoginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'brandnewpassword456' });
  assert.equal(newLoginRes.status, 200);

  // Session from before the reset is revoked.
  const refreshRes = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: oldRefreshToken });
  assert.equal(refreshRes.status, 401);
});

test('POST /api/auth/reset-password rejects an expired token', async () => {
  const userId = await insertUser(uniqueEmail('reset-expired'));
  const raw = await insertResetToken(userId, { expiresAt: new Date(Date.now() - 60_000) });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: raw, newPassword: 'brandnewpassword456' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/reset-password rejects an already-used token', async () => {
  const userId = await insertUser(uniqueEmail('reset-used'));
  const raw = await insertResetToken(userId, {
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: new Date(),
  });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: raw, newPassword: 'brandnewpassword456' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/reset-password rejects a weak new password', async () => {
  const userId = await insertUser(uniqueEmail('reset-weak'));
  const raw = await insertResetToken(userId, { expiresAt: new Date(Date.now() + 60_000) });

  const res = await request(app)
    .post('/api/auth/reset-password')
    .send({ token: raw, newPassword: 'short' });

  assert.equal(res.status, 400);
});
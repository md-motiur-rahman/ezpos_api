import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertTestUser(email) {
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name) VALUES ($1, 'x', 'Test User') RETURNING id`,
    [email]
  );
  return rows[0].id;
}

async function insertToken({ userId, purpose = 'email_verification', expiresAt, usedAt = null }) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query(
    `INSERT INTO verification_tokens (user_id, token_hash, purpose, expires_at, used_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hash, purpose, expiresAt, usedAt]
  );
  return raw;
}

// --- POST /api/auth/register ---

test('POST /api/auth/register creates an unverified user and a verification token', async () => {
  const email = uniqueEmail('register');

  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'supersecurepassword123', fullName: 'New Owner' });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, email);

  const { rows } = await query('SELECT email_verified_at FROM users WHERE email = $1', [email]);
  assert.equal(rows[0].email_verified_at, null);

  const tokenRows = await query(
    `SELECT vt.id FROM verification_tokens vt
     JOIN users u ON u.id = vt.user_id
     WHERE u.email = $1 AND vt.purpose = 'email_verification'`,
    [email]
  );
  assert.equal(tokenRows.rows.length, 1);
});

test('POST /api/auth/register rejects a duplicate email with 409', async () => {
  const email = uniqueEmail('dup');
  const payload = { email, password: 'supersecurepassword123', fullName: 'Dup User' };

  await request(app).post('/api/auth/register').send(payload);
  const res = await request(app).post('/api/auth/register').send(payload);

  assert.equal(res.status, 409);
});

test('POST /api/auth/register rejects a password under 10 characters', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: uniqueEmail('weak'), password: 'short', fullName: 'Weak Pw' });

  assert.equal(res.status, 400);
});

test('POST /api/auth/register rejects an invalid email format', async () => {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: 'not-an-email', password: 'supersecurepassword123', fullName: 'Bad Email' });

  assert.equal(res.status, 400);
});

// --- POST /api/auth/verify-email ---

test('POST /api/auth/verify-email succeeds with a valid token and marks it used', async () => {
  const userId = await insertTestUser(uniqueEmail('verify-ok'));
  const raw = await insertToken({ userId, expiresAt: new Date(Date.now() + 60_000) });

  const res = await request(app).post('/api/auth/verify-email').send({ token: raw });

  assert.equal(res.status, 200);
  const { rows } = await query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
  assert.ok(rows[0].email_verified_at);
});

test('POST /api/auth/verify-email rejects an expired token', async () => {
  const userId = await insertTestUser(uniqueEmail('verify-expired'));
  const raw = await insertToken({ userId, expiresAt: new Date(Date.now() - 60_000) });

  const res = await request(app).post('/api/auth/verify-email').send({ token: raw });

  assert.equal(res.status, 400);
});

test('POST /api/auth/verify-email rejects an already-used token', async () => {
  const userId = await insertTestUser(uniqueEmail('verify-used'));
  const raw = await insertToken({
    userId,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: new Date(),
  });

  const res = await request(app).post('/api/auth/verify-email').send({ token: raw });

  assert.equal(res.status, 400);
});

test('POST /api/auth/verify-email rejects a bogus token', async () => {
  const res = await request(app).post('/api/auth/verify-email').send({ token: 'totally-bogus' });

  assert.equal(res.status, 400);
});

// --- POST /api/auth/resend-verification ---

test('POST /api/auth/resend-verification issues a fresh token for an unverified user', async () => {
  const email = uniqueEmail('resend');
  const userId = await insertTestUser(email);
  await insertToken({ userId, expiresAt: new Date(Date.now() + 60_000) }); // old token

  const res = await request(app).post('/api/auth/resend-verification').send({ email });

  assert.equal(res.status, 200);
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM verification_tokens WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );
  assert.equal(rows[0].count, 1); // old one replaced, not duplicated
});

test('POST /api/auth/resend-verification responds identically for a nonexistent email (no enumeration)', async () => {
  const res = await request(app)
    .post('/api/auth/resend-verification')
    .send({ email: uniqueEmail('nonexistent') });

  assert.equal(res.status, 200);
});
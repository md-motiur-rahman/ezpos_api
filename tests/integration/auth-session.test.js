import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';

const KNOWN_PASSWORD = 'supersecurepassword123';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

/** Inserts a user directly, bypassing register/verify - isolates these tests from Module 1.1's flow. */
async function insertUser({ email, verified = true }) {
  const passwordHash = await bcrypt.hash(KNOWN_PASSWORD, 4); // low cost factor - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test User', $3) RETURNING id`,
    [email, passwordHash, verified ? new Date() : null]
  );
  return rows[0].id;
}

/** The refresh token now travels as an HttpOnly cookie, not a response body field. */
function extractRefreshCookie(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const cookie = setCookie.find((c) => c.startsWith('refreshToken='));
  return cookie.split(';')[0];
}

async function loginAs(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: KNOWN_PASSWORD });
  return { accessToken: res.body.accessToken, refreshCookie: extractRefreshCookie(res) };
}

// --- POST /api/auth/login ---

test('POST /api/auth/login succeeds with correct credentials', async () => {
  const email = uniqueEmail('login-ok');
  await insertUser({ email });

  const res = await request(app).post('/api/auth/login').send({ email, password: KNOWN_PASSWORD });

  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  // Cookie-only by design - never in the JSON body, so an XSS payload reading
  // the response can't get at it the way it could a body field.
  assert.equal(res.body.refreshToken, undefined);

  const refreshCookie = extractRefreshCookie(res);
  assert.ok(refreshCookie);
  assert.match(refreshCookie, /^refreshToken=/);
  const setCookie = res.headers['set-cookie'].find((c) => c.startsWith('refreshToken='));
  assert.match(setCookie, /HttpOnly/i);
});

test('POST /api/auth/login rejects a wrong password with 401', async () => {
  const email = uniqueEmail('login-wrongpw');
  await insertUser({ email });

  const res = await request(app).post('/api/auth/login').send({ email, password: 'wrongpassword123' });

  assert.equal(res.status, 401);
});

test('POST /api/auth/login rejects a nonexistent email with 401 (same as wrong password)', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: uniqueEmail('nonexistent'), password: KNOWN_PASSWORD });

  assert.equal(res.status, 401);
});

test('POST /api/auth/login rejects an unverified account with 403', async () => {
  const email = uniqueEmail('login-unverified');
  await insertUser({ email, verified: false });

  const res = await request(app).post('/api/auth/login').send({ email, password: KNOWN_PASSWORD });

  assert.equal(res.status, 403);
});

// --- POST /api/auth/refresh ---

test('POST /api/auth/refresh issues a new token pair for a valid refresh token', async () => {
  const email = uniqueEmail('refresh-ok');
  await insertUser({ email });
  const { refreshCookie } = await loginAs(email);

  const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);

  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.equal(res.body.refreshToken, undefined); // cookie-only, same as login

  const newRefreshCookie = extractRefreshCookie(res);
  assert.ok(newRefreshCookie);
  assert.notEqual(newRefreshCookie, refreshCookie); // rotated, not reused
});

test('POST /api/auth/refresh rejects a token that was already rotated out', async () => {
  const email = uniqueEmail('refresh-rotated');
  await insertUser({ email });
  const { refreshCookie } = await loginAs(email);

  await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie); // first use rotates it
  const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie); // reuse

  assert.equal(res.status, 401);
});

test('POST /api/auth/refresh rejects a bogus token', async () => {
  const res = await request(app).post('/api/auth/refresh').set('Cookie', 'refreshToken=totally-bogus');

  assert.equal(res.status, 401);
});

test('POST /api/auth/refresh rejects a missing cookie', async () => {
  const res = await request(app).post('/api/auth/refresh');

  assert.equal(res.status, 401);
});

// --- POST /api/auth/logout ---

test('POST /api/auth/logout revokes the session so it can no longer be refreshed', async () => {
  const email = uniqueEmail('logout-ok');
  await insertUser({ email });
  const { refreshCookie } = await loginAs(email);

  const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', refreshCookie);
  assert.equal(logoutRes.status, 200);

  const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
  assert.equal(refreshRes.status, 401);
});

test('POST /api/auth/logout with an already-invalid token is a no-op, not an error', async () => {
  const res = await request(app).post('/api/auth/logout').set('Cookie', 'refreshToken=totally-bogus');

  assert.equal(res.status, 200);
});

test('POST /api/auth/logout with no cookie at all is a no-op, not an error', async () => {
  const res = await request(app).post('/api/auth/logout');

  assert.equal(res.status, 200);
});
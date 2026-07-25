import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

const KNOWN_PASSWORD = 'originalpassword123';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser(email) {
  const passwordHash = await bcrypt.hash(KNOWN_PASSWORD, 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test User', now()) RETURNING id, email`,
    [email, passwordHash]
  );
  return rows[0];
}

async function authHeaderFor(user) {
  return `Bearer ${signAccessToken(user)}`;
}

// --- Auth guard ---

test('all /api/me endpoints reject requests with no auth token', async () => {
  const getRes = await request(app).get('/api/me');
  const patchRes = await request(app).patch('/api/me').send({ fullName: 'X' });
  const pwRes = await request(app)
    .post('/api/me/change-password')
    .send({ currentPassword: 'x', newPassword: 'newpassword123' });
  const emailRes = await request(app)
    .post('/api/me/change-email')
    .send({ currentPassword: 'x', newEmail: 'x@example.com' });

  for (const res of [getRes, patchRes, pwRes, emailRes]) {
    assert.equal(res.status, 401);
  }
});

test('/api/me rejects an invalid Bearer token', async () => {
  const res = await request(app).get('/api/me').set('Authorization', 'Bearer garbage');
  assert.equal(res.status, 401);
});

// --- GET /api/me ---

test('GET /api/me returns the authenticated user profile', async () => {
  const email = uniqueEmail('profile');
  const user = await insertUser(email);

  const res = await request(app).get('/api/me').set('Authorization', await authHeaderFor(user));

  assert.equal(res.status, 200);
  assert.equal(res.body.email, email);
  assert.equal(res.body.fullName, 'Test User');
  assert.equal(res.body.emailVerified, true);
  assert.equal(res.body.pendingEmail, null);
});

// --- PATCH /api/me ---

test('PATCH /api/me updates the full name', async () => {
  const user = await insertUser(uniqueEmail('rename'));

  const res = await request(app)
    .patch('/api/me')
    .set('Authorization', await authHeaderFor(user))
    .send({ fullName: 'Updated Name' });

  assert.equal(res.status, 200);
  assert.equal(res.body.fullName, 'Updated Name');
});

test('PATCH /api/me rejects an empty full name', async () => {
  const user = await insertUser(uniqueEmail('rename-empty'));

  const res = await request(app)
    .patch('/api/me')
    .set('Authorization', await authHeaderFor(user))
    .send({ fullName: '' });

  assert.equal(res.status, 400);
});

// --- POST /api/me/change-password ---

test('POST /api/me/change-password succeeds and revokes existing sessions', async () => {
  const email = uniqueEmail('changepw');
  const user = await insertUser(email);

  const loginRes = await request(app).post('/api/auth/login').send({ email, password: KNOWN_PASSWORD });
  const oldRefreshToken = loginRes.body.refreshToken;

  const res = await request(app)
    .post('/api/me/change-password')
    .set('Authorization', await authHeaderFor(user))
    .send({ currentPassword: KNOWN_PASSWORD, newPassword: 'brandnewpassword456' });
  assert.equal(res.status, 200);

  const refreshRes = await request(app)
    .post('/api/auth/refresh')
    .send({ refreshToken: oldRefreshToken });
  assert.equal(refreshRes.status, 401);

  const newLoginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'brandnewpassword456' });
  assert.equal(newLoginRes.status, 200);
});

test('POST /api/me/change-password rejects a wrong current password', async () => {
  const user = await insertUser(uniqueEmail('changepw-wrong'));

  const res = await request(app)
    .post('/api/me/change-password')
    .set('Authorization', await authHeaderFor(user))
    .send({ currentPassword: 'totallywrongpassword', newPassword: 'brandnewpassword456' });

  assert.equal(res.status, 401);
});

// --- POST /api/me/change-email + confirm ---

test('POST /api/me/change-email sets pending_email and confirming updates the real email', async () => {
  const email = uniqueEmail('changeemail');
  const user = await insertUser(email);
  const newEmail = uniqueEmail('changeemail-new');

  const res = await request(app)
    .post('/api/me/change-email')
    .set('Authorization', await authHeaderFor(user))
    .send({ currentPassword: KNOWN_PASSWORD, newEmail });
  assert.equal(res.status, 200);

  const { rows } = await query('SELECT email, pending_email FROM users WHERE id = $1', [user.id]);
  assert.equal(rows[0].email, email); // unchanged until confirmed
  assert.equal(rows[0].pending_email, newEmail);

  // Simulate clicking the confirmation link, using a directly-inserted
  // token (same pattern as the other token-flow tests in this project).
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await query(
    `INSERT INTO verification_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'email_change', $3)`,
    [user.id, hash, new Date(Date.now() + 60_000)]
  );

  const confirmRes = await request(app).post('/api/auth/confirm-email-change').send({ token: raw });
  assert.equal(confirmRes.status, 200);
  assert.equal(confirmRes.body.email, newEmail);

  const { rows: afterRows } = await query(
    'SELECT email, pending_email, email_verified_at FROM users WHERE id = $1',
    [user.id]
  );
  assert.equal(afterRows[0].email, newEmail);
  assert.equal(afterRows[0].pending_email, null);
  assert.ok(afterRows[0].email_verified_at);
});

test('POST /api/me/change-email rejects an email already in use', async () => {
  const takenEmail = uniqueEmail('taken');
  await insertUser(takenEmail);
  const user = await insertUser(uniqueEmail('wants-taken-email'));

  const res = await request(app)
    .post('/api/me/change-email')
    .set('Authorization', await authHeaderFor(user))
    .send({ currentPassword: KNOWN_PASSWORD, newEmail: takenEmail });

  assert.equal(res.status, 409);
});

test('POST /api/me/change-email rejects a wrong current password', async () => {
  const user = await insertUser(uniqueEmail('changeemail-wrongpw'));

  const res = await request(app)
    .post('/api/me/change-email')
    .set('Authorization', await authHeaderFor(user))
    .send({ currentPassword: 'totallywrongpassword', newEmail: uniqueEmail('irrelevant') });

  assert.equal(res.status, 401);
});
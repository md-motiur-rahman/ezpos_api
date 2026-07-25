import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('owner'), passwordHash]
  );
  return rows[0].id;
}

function authHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Test Restaurant Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

// --- Auth guard ---

test('company endpoints reject requests with no auth token', async () => {
  const createRes = await request(app).post('/api/companies').send(VALID_COMPANY);
  const getRes = await request(app).get('/api/companies/mine');

  assert.equal(createRes.status, 401);
  assert.equal(getRes.status, 401);
});

// --- POST /api/companies ---

test('POST /api/companies creates a company for the authenticated owner', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 201);
  assert.equal(res.body.name, VALID_COMPANY.name);
});

test('POST /api/companies rejects a second active company for the same owner', async () => {
  const userId = await insertUser();

  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);
  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 409);
});

test('POST /api/companies allows a new company after the previous one was soft-deleted', async () => {
  const userId = await insertUser();

  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);
  await query(`UPDATE companies SET deleted_at = now() WHERE owner_user_id = $1`, [userId]);

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 201);
});

test('POST /api/companies rejects missing required fields', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send({ name: 'Missing Everything Else Ltd' });

  assert.equal(res.status, 400);
});

// --- GET /api/companies/mine ---

test('GET /api/companies/mine returns the owner active company', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 200);
  assert.equal(res.body.name, VALID_COMPANY.name);
});

test('GET /api/companies/mine returns 404 when the owner has no company', async () => {
  const userId = await insertUser();

  const res = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 404);
});

// --- PATCH /api/companies/mine ---

test('PATCH /api/companies/mine updates only the provided fields', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .patch('/api/companies/mine')
    .set('Authorization', authHeaderFor(userId))
    .send({ city: 'Manchester' });

  assert.equal(res.status, 200);
  assert.equal(res.body.city, 'Manchester');
  assert.equal(res.body.name, VALID_COMPANY.name); // untouched fields preserved
});

// --- DELETE /api/companies/mine ---

test('DELETE /api/companies/mine soft-deletes and GET afterward returns 404', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const deleteRes = await request(app)
    .delete('/api/companies/mine')
    .set('Authorization', authHeaderFor(userId));
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));
  assert.equal(getRes.status, 404);
});

// --- POST /api/companies/mine/business-type ---

test('POST /api/companies/mine/business-type sets the value to single', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'single');
});

test('POST /api/companies/mine/business-type sets the value to chain', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'chain');
});

test('POST /api/companies/mine/business-type allows switching direction freely for now', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });
  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'single');
});

test('POST /api/companies/mine/business-type rejects an invalid value', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'franchise' });

  assert.equal(res.status, 400);
});

test('POST /api/companies/mine/business-type returns 404 with no active company', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 404);
});

test('POST /api/companies/mine/business-type rejects requests with no auth token', async () => {
  const res = await request(app).post('/api/companies/mine/business-type').send({ businessType: 'single' });

  assert.equal(res.status, 401);
});

test('GET /api/companies/mine reflects businessType, including null before it is ever set', async () => {
  const userId = await insertUser();
  const createRes = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);
  assert.equal(createRes.body.businessType, null);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });

  const getRes = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));
  assert.equal(getRes.body.businessType, 'chain');
});
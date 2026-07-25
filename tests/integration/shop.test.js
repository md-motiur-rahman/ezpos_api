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

const VALID_SHOP = {
  name: 'Test Shop',
  addressLine1: '2 Market Street',
  city: 'London',
  postcode: 'E1 1AA',
  country: 'UK',
  phone: '02011112222',
};

/** Creates a user + company, optionally setting business_type, returns the auth header + userId. */
async function setupOwnerWithCompany(businessType) {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  if (businessType) {
    await request(app)
      .post('/api/companies/mine/business-type')
      .set('Authorization', header)
      .send({ businessType });
  }
  return { userId, header };
}

// --- Auth guard ---

test('shop endpoints reject requests with no auth token', async () => {
  const createRes = await request(app).post('/api/shops').send(VALID_SHOP);
  const listRes = await request(app).get('/api/shops');

  assert.equal(createRes.status, 401);
  assert.equal(listRes.status, 401);
});

// --- POST /api/shops ---

test('POST /api/shops is blocked until business_type is set', async () => {
  const { header } = await setupOwnerWithCompany(null);

  const res = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  assert.equal(res.status, 400);
});

test('POST /api/shops creates a shop once business_type is single', async () => {
  const { header } = await setupOwnerWithCompany('single');

  const res = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  assert.equal(res.status, 201);
  assert.equal(res.body.name, VALID_SHOP.name);
});

test('POST /api/shops rejects a second shop for a single-shop business', async () => {
  const { header } = await setupOwnerWithCompany('single');

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  assert.equal(res.status, 409);
});

test('POST /api/shops allows many shops for a chain business', async () => {
  const { header } = await setupOwnerWithCompany('chain');

  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  const second = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });
  const third = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Third Shop' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(third.status, 201);
});

test('POST /api/shops rejects missing required fields', async () => {
  const { header } = await setupOwnerWithCompany('chain');

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ name: 'Missing Everything Else' });

  assert.equal(res.status, 400);
});

// --- GET /api/shops ---

test('GET /api/shops lists only my active shops', async () => {
  const { header } = await setupOwnerWithCompany('chain');
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  const res = await request(app).get('/api/shops').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// --- GET /api/shops/:id ---

test('GET /api/shops/:id returns the shop when owned by the requester', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const res = await request(app).get(`/api/shops/${created.body.id}`).set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
});

test('GET /api/shops/:id returns 404 for a shop owned by another company', async () => {
  const ownerA = await setupOwnerWithCompany('single');
  const ownerB = await setupOwnerWithCompany('single');
  const created = await request(app)
    .post('/api/shops')
    .set('Authorization', ownerA.header)
    .send(VALID_SHOP);

  const res = await request(app)
    .get(`/api/shops/${created.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

test('GET /api/shops/:id returns 400 for a malformed id', async () => {
  const { header } = await setupOwnerWithCompany('single');

  const res = await request(app).get('/api/shops/not-a-uuid').set('Authorization', header);

  assert.equal(res.status, 400);
});

// --- PATCH /api/shops/:id ---

test('PATCH /api/shops/:id updates only the provided fields', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const res = await request(app)
    .patch(`/api/shops/${created.body.id}`)
    .set('Authorization', header)
    .send({ city: 'Manchester' });

  assert.equal(res.status, 200);
  assert.equal(res.body.city, 'Manchester');
  assert.equal(res.body.name, VALID_SHOP.name); // untouched
});

// --- DELETE /api/shops/:id ---

test('DELETE /api/shops/:id soft-deletes; shop disappears from list and GET afterward returns 404', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const deleteRes = await request(app).delete(`/api/shops/${created.body.id}`).set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app).get(`/api/shops/${created.body.id}`).set('Authorization', header);
  assert.equal(getRes.status, 404);

  const listRes = await request(app).get('/api/shops').set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('DELETE /api/shops/:id allows a single-shop business to add a new shop afterward', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app).delete(`/api/shops/${created.body.id}`).set('Authorization', header);

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Replacement Shop' });

  assert.equal(res.status, 201);
});

// --- Reverse guard: switching business_type to 'single' with active shops (resolves 2.2 flag) ---

test('switching business_type to single is blocked with more than one active shop', async () => {
  const { header } = await setupOwnerWithCompany('chain');
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });

  assert.equal(res.status, 409);
});

test('switching business_type to single is allowed with exactly one active shop', async () => {
  const { header } = await setupOwnerWithCompany('chain');
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
});

test('switching business_type to single is allowed with zero shops', async () => {
  const { header } = await setupOwnerWithCompany('chain');

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
});

test('switching business_type to chain is always allowed regardless of shop count', async () => {
  const { header } = await setupOwnerWithCompany('single');
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'chain' });

  assert.equal(res.status, 200);
});
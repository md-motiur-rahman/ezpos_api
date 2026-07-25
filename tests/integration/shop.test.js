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
  vatRegistered: true,
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

// --- Shop settings (Module 2.4): kdsEnabled, rotaEnabled, vatRegistered, defaultVatRate ---

test('POST /api/shops rejects a missing vatRegistered', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const { vatRegistered, ...withoutVatRegistered } = VALID_SHOP;

  const res = await request(app).post('/api/shops').set('Authorization', header).send(withoutVatRegistered);

  assert.equal(res.status, 400);
});

test('POST /api/shops defaults kdsEnabled and rotaEnabled to false when not provided', async () => {
  const { header } = await setupOwnerWithCompany('single');

  const res = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  assert.equal(res.status, 201);
  assert.equal(res.body.kdsEnabled, false);
  assert.equal(res.body.rotaEnabled, false);
});

test('POST /api/shops accepts explicit kdsEnabled, rotaEnabled, and defaultVatRate', async () => {
  const { header } = await setupOwnerWithCompany('single');

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, kdsEnabled: true, rotaEnabled: true, defaultVatRate: 20 });

  assert.equal(res.status, 201);
  assert.equal(res.body.kdsEnabled, true);
  assert.equal(res.body.rotaEnabled, true);
  assert.equal(res.body.defaultVatRate, 20);
});

test('POST /api/shops rejects a defaultVatRate outside 0-100', async () => {
  const { header } = await setupOwnerWithCompany('single');

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, defaultVatRate: 150 });

  assert.equal(res.status, 400);
});

test('PATCH /api/shops/:id toggles kdsEnabled independently of other settings', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const res = await request(app)
    .patch(`/api/shops/${created.body.id}`)
    .set('Authorization', header)
    .send({ kdsEnabled: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.kdsEnabled, true);
  assert.equal(res.body.rotaEnabled, false); // untouched
  assert.equal(res.body.vatRegistered, true); // untouched
});

test('PATCH /api/shops/:id updates vatRegistered and defaultVatRate together', async () => {
  const { header } = await setupOwnerWithCompany('single');
  const created = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, vatRegistered: false });

  const res = await request(app)
    .patch(`/api/shops/${created.body.id}`)
    .set('Authorization', header)
    .send({ vatRegistered: true, defaultVatRate: 20 });

  assert.equal(res.status, 200);
  assert.equal(res.body.vatRegistered, true);
  assert.equal(res.body.defaultVatRate, 20);
});

// --- Per-shop subscription line items (Module 3.2) ---

/** Reads the billing ids straight from the DB - they're internal, not in API responses. */
async function billingState(userId) {
  const { rows } = await query(
    `SELECT c.id AS company_id, c.stripe_subscription_id,
            s.id AS shop_id, s.stripe_subscription_item_id, s.deleted_at
     FROM companies c
     LEFT JOIN shops s ON s.company_id = c.id
     WHERE c.owner_user_id = $1 AND c.deleted_at IS NULL
     ORDER BY s.created_at`,
    [userId]
  );
  return rows;
}

test('creating the first shop creates a subscription and a line item', async () => {
  const { userId, header } = await setupOwnerWithCompany('chain');

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const rows = await billingState(userId);
  assert.ok(rows[0].stripe_subscription_id.startsWith('sub_test_'));
  assert.ok(rows[0].stripe_subscription_item_id.startsWith('si_test_'));
});

test('creating a second shop reuses the subscription and adds a separate line item', async () => {
  const { userId, header } = await setupOwnerWithCompany('chain');

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  const rows = await billingState(userId);
  assert.equal(rows.length, 2);
  // Same subscription for both...
  assert.equal(rows[0].stripe_subscription_id, rows[1].stripe_subscription_id);
  // ...but each shop has its own line item.
  assert.notEqual(rows[0].stripe_subscription_item_id, rows[1].stripe_subscription_item_id);
});

test('deleting a non-last shop leaves the subscription in place', async () => {
  const { userId, header } = await setupOwnerWithCompany('chain');
  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  await request(app).delete(`/api/shops/${first.body.id}`).set('Authorization', header);

  const rows = await billingState(userId);
  assert.ok(rows[0].stripe_subscription_id); // subscription survives
});

test('deleting the last shop cancels the subscription and clears the id', async () => {
  const { userId, header } = await setupOwnerWithCompany('single');
  const created = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  await request(app).delete(`/api/shops/${created.body.id}`).set('Authorization', header);

  const rows = await billingState(userId);
  assert.equal(rows[0].stripe_subscription_id, null);
});

test('adding a shop after the last one closed starts a fresh subscription', async () => {
  const { userId, header } = await setupOwnerWithCompany('single');
  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  const firstSub = (await billingState(userId))[0].stripe_subscription_id;

  await request(app).delete(`/api/shops/${first.body.id}`).set('Authorization', header);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Replacement Shop' });

  const rows = await billingState(userId);
  const active = rows.find((r) => r.deleted_at === null);
  assert.ok(active.stripe_subscription_id);
  assert.notEqual(active.stripe_subscription_id, firstSub);
});
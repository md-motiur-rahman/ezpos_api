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
    [uniqueEmail('staff-owner'), passwordHash]
  );
  return rows[0].id;
}

function authHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Staff Test Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

const VALID_SHOP = {
  name: 'Staff Test Shop',
  addressLine1: '2 Market Street',
  city: 'London',
  postcode: 'E1 1AA',
  country: 'UK',
  phone: '02011112222',
  vatRegistered: true,
};

/** Owner + company + business type + one shop, ready for staff tests. */
async function setupShop() {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'chain' });
  const shopRes = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  return { userId, header, shopId: shopRes.body.id };
}

async function staffRows(shopId) {
  const { rows } = await query(
    `SELECT id, full_name, role, staff_id_code, deleted_at FROM staff WHERE shop_id = $1 ORDER BY created_at`,
    [shopId]
  );
  return rows;
}

// --- Auth guard ---

test('staff endpoints reject requests with no auth token', async () => {
  const { shopId } = await setupShop();

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .send({ fullName: 'Sam Server', role: 'server' });
  const listRes = await request(app).get(`/api/shops/${shopId}/staff`);

  assert.equal(createRes.status, 401);
  assert.equal(listRes.status, 401);
});

// --- POST /api/shops/:shopId/staff ---

test('POST staff creates a staff member with a generated staff ID and one-time PIN', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Sam Server', role: 'server' });

  assert.equal(res.status, 201);
  assert.equal(res.body.fullName, 'Sam Server');
  assert.equal(res.body.role, 'server');
  assert.match(res.body.staffIdCode, /^\d{8}$/);
  assert.match(res.body.pin, /^\d{8}$/);

  const rows = await staffRows(shopId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].staff_id_code, res.body.staffIdCode);
});

test('POST staff rejects a role of owner', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Sneaky', role: 'owner' });

  assert.equal(res.status, 400);
});

test('POST staff rejects an unknown role', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Sneaky', role: 'regional_manager' });

  assert.equal(res.status, 400);
});

test('POST staff rejects a missing fullName', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ role: 'server' });

  assert.equal(res.status, 400);
});

test('POST staff returns 404 for a shop belonging to another company', async () => {
  const ownerA = await setupShop();
  const ownerB = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/staff`)
    .set('Authorization', ownerB.header)
    .send({ fullName: 'Cross Shop', role: 'server' });

  assert.equal(res.status, 404);
});

test('two staff members on the same shop get different staff ID codes', async () => {
  const { header, shopId } = await setupShop();

  const first = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'First', role: 'server' });
  const second = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Second', role: 'chef' });

  assert.notEqual(first.body.staffIdCode, second.body.staffIdCode);
});

// --- GET /api/shops/:shopId/staff ---

test('GET staff lists only active staff for that shop', async () => {
  const { header, shopId } = await setupShop();
  await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'A', role: 'server' });
  await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'B', role: 'chef' });

  const res = await request(app).get(`/api/shops/${shopId}/staff`).set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].pin, undefined); // never included outside creation
});

// --- GET /api/shops/:shopId/staff/:staffId ---

test('GET staff/:staffId returns the staff member when owned by the requester', async () => {
  const { header, shopId } = await setupShop();
  const created = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Gettable', role: 'manager' });

  const res = await request(app)
    .get(`/api/shops/${shopId}/staff/${created.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
});

test('GET staff/:staffId returns 404 for staff belonging to another shop', async () => {
  const ownerA = await setupShop();
  const ownerB = await setupShop();
  const created = await request(app)
    .post(`/api/shops/${ownerA.shopId}/staff`)
    .set('Authorization', ownerA.header)
    .send({ fullName: 'Isolated', role: 'server' });

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/staff/${created.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

test('GET staff/:staffId returns 400 for a malformed staff id', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .get(`/api/shops/${shopId}/staff/not-a-uuid`)
    .set('Authorization', header);

  assert.equal(res.status, 400);
});

// --- PATCH /api/shops/:shopId/staff/:staffId ---

test('PATCH staff updates fullName and role, and cannot touch the PIN or staff ID', async () => {
  const { header, shopId } = await setupShop();
  const created = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'Original Name', role: 'server' });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/staff/${created.body.id}`)
    .set('Authorization', header)
    .send({ fullName: 'Updated Name', role: 'shift_manager' });

  assert.equal(res.status, 200);
  assert.equal(res.body.fullName, 'Updated Name');
  assert.equal(res.body.role, 'shift_manager');
  assert.equal(res.body.staffIdCode, created.body.staffIdCode); // unchanged
});

// --- DELETE /api/shops/:shopId/staff/:staffId ---

test('DELETE staff deactivates; excluded from list and a fresh GET returns 404', async () => {
  const { header, shopId } = await setupShop();
  const created = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', header)
    .send({ fullName: 'To Deactivate', role: 'server' });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/staff/${created.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/staff/${created.body.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 404);

  const listRes = await request(app).get(`/api/shops/${shopId}/staff`).set('Authorization', header);
  assert.equal(listRes.body.length, 0);

  const rows = await staffRows(shopId);
  assert.ok(rows[0].deleted_at); // soft-deleted, history preserved
});
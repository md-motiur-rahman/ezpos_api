import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('inventory-create-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Inventory Create Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });
  const shopRes = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Test Shop',
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: true,
    });
  return { userId, header, shopId: shopRes.body.id };
}

async function insertStaff(shopId, role) {
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = String(crypto.randomInt(10_000_000, 99_999_999));
  const { rows } = await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [shopId, `Test ${role}`, role, staffIdCode, pinHash]
  );
  return { id: rows[0].id, staffIdCode };
}

async function staffHeaderFor(shopId, staffIdCode) {
  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  return `Bearer ${res.body.sessionToken}`;
}

async function managerHeaderFor(shopId) {
  const manager = await insertStaff(shopId, 'manager');
  return staffHeaderFor(shopId, manager.staffIdCode);
}

// --- Create ---

test('POST inventory-items creates an item, defaulting quantityOnHand to 0', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Chicken Breast');
  assert.equal(res.body.unit, 'kg');
  assert.equal(res.body.quantityOnHand, 0);
});

test('POST inventory-items accepts an explicit quantityOnHand', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Flour', unit: 'kg', quantityOnHand: 25 });

  assert.equal(res.status, 201);
  assert.equal(res.body.quantityOnHand, 25);
});

test('POST inventory-items rejects a negative quantityOnHand', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Flour', unit: 'kg', quantityOnHand: -5 });

  assert.equal(res.status, 400);
});

test('POST inventory-items rejects a missing unit', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Flour' });

  assert.equal(res.status, 400);
});

// --- List / Get ---

test('GET inventory-items lists items for the shop', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Flour', unit: 'kg' });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('GET a single inventory item returns it', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.id, item.body.id);
});

// --- Auth guard ---

test('inventory endpoints reject requests with no auth token', async () => {
  const { shopId } = await setupOwnerWithShop();
  const res = await request(app).get(`/api/shops/${shopId}/inventory-items`);
  assert.equal(res.status, 401);
});
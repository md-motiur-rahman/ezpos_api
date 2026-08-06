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
    [uniqueEmail('inventory-manage-owner'), passwordHash]
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
      name: 'Inventory Manage Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'chain' });
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

// --- Cross-shop ---

test('an inventory item from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const managerHeaderA = await managerHeaderFor(ownerA.shopId);
  const item = await request(app)
    .post(`/api/shops/${ownerA.shopId}/inventory-items`)
    .set('Authorization', managerHeaderA)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

// --- Update / Delete ---

test('PATCH inventory-items overwrites quantityOnHand directly (a manual stock correction)', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader)
    .send({ quantityOnHand: 7.5 });

  assert.equal(res.status, 200);
  assert.equal(res.body.quantityOnHand, 7.5);
});

test('PATCH inventory-items rejects a negative quantityOnHand', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader)
    .send({ quantityOnHand: -1 });

  assert.equal(res.status, 400);
});

test('DELETE removes an inventory item; it disappears from listings', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader);
  assert.equal(listRes.body.length, 0);
});

// --- Permissions ---

test('a Chef (VIEW_INVENTORY only) can read but not create inventory items', async () => {
  const { shopId } = await setupOwnerWithShop();
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', chefHeader);
  assert.equal(getRes.status, 200);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', chefHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  assert.equal(createRes.status, 403);
});

test('a Server (neither permission) cannot read or create inventory items', async () => {
  const { shopId } = await setupOwnerWithShop();
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', serverHeader);
  assert.equal(getRes.status, 403);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', serverHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  assert.equal(createRes.status, 403);
});

test('the Owner can manage inventory directly (bypasses the permission system entirely)', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  assert.equal(res.status, 201);
});
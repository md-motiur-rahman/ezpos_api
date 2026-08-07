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
    [uniqueEmail('lowstock-filter-owner'), passwordHash]
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
      name: 'Low Stock Filter Test Ltd',
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

// --- The low-stock filter (the Manager's "low stock page") ---

test('GET with lowStockOnly=true returns only items at or below their threshold', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Low Item', unit: 'kg', quantityOnHand: 1, lowStockThreshold: 5 });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Well Stocked Item', unit: 'kg', quantityOnHand: 20, lowStockThreshold: 5 });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Untracked Item', unit: 'kg', quantityOnHand: 0 });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items?lowStockOnly=true`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Low Item');
});

test('GET without lowStockOnly returns every item regardless of stock level', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Low Item', unit: 'kg', quantityOnHand: 1, lowStockThreshold: 5 });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Well Stocked Item', unit: 'kg', quantityOnHand: 20, lowStockThreshold: 5 });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('a Chef (VIEW_INVENTORY only) can use the lowStockOnly filter', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Low Item', unit: 'kg', quantityOnHand: 1, lowStockThreshold: 5 });
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items?lowStockOnly=true`)
    .set('Authorization', chefHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

// --- Cross-shop ---

test('a Manager only sees their own shop\'s low-stock items, not another shop\'s', async () => {
  const ownerA = await setupOwnerWithShop();
  const managerHeaderA = await managerHeaderFor(ownerA.shopId);
  await request(app)
    .post(`/api/shops/${ownerA.shopId}/inventory-items`)
    .set('Authorization', managerHeaderA)
    .send({ name: 'Shop A Low Item', unit: 'kg', quantityOnHand: 1, lowStockThreshold: 5 });

  const ownerB = await setupOwnerWithShop();
  const managerHeaderB = await managerHeaderFor(ownerB.shopId);
  await request(app)
    .post(`/api/shops/${ownerB.shopId}/inventory-items`)
    .set('Authorization', managerHeaderB)
    .send({ name: 'Shop B Low Item', unit: 'kg', quantityOnHand: 1, lowStockThreshold: 5 });

  const res = await request(app)
    .get(`/api/shops/${ownerA.shopId}/inventory-items?lowStockOnly=true`)
    .set('Authorization', managerHeaderA);

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Shop A Low Item');
});

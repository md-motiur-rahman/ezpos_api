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
    [uniqueEmail('lowstock-threshold-owner'), passwordHash]
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
      name: 'Low Stock Threshold Test Ltd',
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

// --- Setting / clearing the threshold ---

test('POST creates an item with a lowStockThreshold', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10, lowStockThreshold: 3 });

  assert.equal(res.status, 201);
  assert.equal(res.body.lowStockThreshold, 3);
});

test('an item created with no lowStockThreshold has it as null', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg' });

  assert.equal(res.status, 201);
  assert.equal(res.body.lowStockThreshold, null);
});

test('PATCH sets a lowStockThreshold on an existing item', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader)
    .send({ lowStockThreshold: 5 });

  assert.equal(res.status, 200);
  assert.equal(res.body.lowStockThreshold, 5);
});

test('PATCH with an explicit null clears the threshold, distinct from omitting the field', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10, lowStockThreshold: 5 });

  // Omitting the field entirely leaves it untouched.
  const untouchedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast (renamed)' });
  assert.equal(untouchedRes.body.lowStockThreshold, 5);

  // Explicit null clears it.
  const clearedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', managerHeader)
    .send({ lowStockThreshold: null });
  assert.equal(clearedRes.status, 200);
  assert.equal(clearedRes.body.lowStockThreshold, null);
});

test('lowStockThreshold cannot be negative', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Chicken Breast', unit: 'kg', lowStockThreshold: -1 });

  assert.equal(res.status, 400);
});

// --- Computed isLowStock ---

test('isLowStock is true when quantityOnHand is at or below the threshold', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const atThreshold = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'At Threshold', unit: 'kg', quantityOnHand: 5, lowStockThreshold: 5 });
  const belowThreshold = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Below Threshold', unit: 'kg', quantityOnHand: 2, lowStockThreshold: 5 });

  assert.equal(atThreshold.body.isLowStock, true);
  assert.equal(belowThreshold.body.isLowStock, true);
});

test('isLowStock is false when quantityOnHand is above the threshold', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Well Stocked', unit: 'kg', quantityOnHand: 20, lowStockThreshold: 5 });

  assert.equal(res.body.isLowStock, false);
});

test('isLowStock is false when no threshold is configured, even at zero quantity', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', managerHeader)
    .send({ name: 'Untracked Item', unit: 'kg', quantityOnHand: 0 });

  assert.equal(res.body.isLowStock, false);
});
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
    [uniqueEmail('wastageperm-owner'), passwordHash]
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
      name: 'Wastage Perm Test Ltd',
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
  console.log('[DIAG] shopId:', shopRes.body.id, 'shop create status:', shopRes.status);
  return { header, shopId: shopRes.body.id };
}

async function insertStaff(shopId, role) {
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = String(crypto.randomInt(10_000_000, 99_999_999));
  try {
    const { rows } = await query(
      `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [shopId, `Test ${role}`, role, staffIdCode, pinHash]
    );
    console.log('[DIAG] inserted staff:', role, 'id:', rows[0].id, 'staffIdCode:', staffIdCode);
    return { id: rows[0].id, staffIdCode };
  } catch (err) {
    console.log('[DIAG] insertStaff FAILED:', err.message);
    throw err;
  }
}

async function staffHeaderFor(shopId, staffIdCode) {
  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  console.log('[DIAG] login status:', res.status, 'body:', JSON.stringify(res.body));
  return `Bearer ${res.body.sessionToken}`;
}

test('a Chef (VIEW_INVENTORY) can both read AND log wastage - read and write share one permission gate', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });
  console.log('[DIAG] item create status:', itemRes.status);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const getRes = await request(app).get(`/api/shops/${shopId}/wastage-logs`).set('Authorization', chefHeader);
  assert.equal(getRes.status, 200);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', chefHeader)
    .send({ items: [{ inventoryItemId: itemRes.body.id, quantityWasted: 1, reason: 'spoiled' }] });
  assert.equal(createRes.status, 201);
});

test('a Server (neither permission) cannot read or log wastage', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const getRes = await request(app).get(`/api/shops/${shopId}/wastage-logs`).set('Authorization', serverHeader);
  assert.equal(getRes.status, 403);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', serverHeader)
    .send({ items: [{ inventoryItemId: itemRes.body.id, quantityWasted: 1, reason: 'spoiled' }] });
  assert.equal(createRes.status, 403);
});

test('a Manager can still read and log wastage', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', managerHeader)
    .send({ items: [{ inventoryItemId: itemRes.body.id, quantityWasted: 1, reason: 'spoiled' }] });

  assert.equal(res.status, 201);
});

test('the Owner can log wastage directly (bypasses the permission system entirely)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg', quantityOnHand: 10 });

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: itemRes.body.id, quantityWasted: 1, reason: 'spoiled' }] });

  assert.equal(res.status, 201);
});
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
    [uniqueEmail('receivingperm-owner'), passwordHash]
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
      name: 'Receiving Perm Test Ltd',
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
  return { header, shopId: shopRes.body.id };
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

test('a Chef (VIEW_INVENTORY only) cannot log a receipt - it mutates stock, requiring MANAGE_INVENTORY', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplierRes = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name: 'Bidfood' });
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  const poRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: supplierRes.body.id,
      items: [{ inventoryItemId: itemRes.body.id, quantity: 10 }],
    });
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${poRes.body.id}/receipts`)
    .set('Authorization', chefHeader)
    .send({ items: [{ purchaseOrderItemId: poRes.body.items[0].id, quantityReceived: 10 }] });

  assert.equal(res.status, 403);
});

test('a Manager (MANAGE_INVENTORY) can log a receipt', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplierRes = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name: 'Bidfood' });
  const itemRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Chicken Breast', unit: 'kg' });
  const poRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: supplierRes.body.id,
      items: [{ inventoryItemId: itemRes.body.id, quantity: 10 }],
    });
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${poRes.body.id}/receipts`)
    .set('Authorization', managerHeader)
    .send({ items: [{ purchaseOrderItemId: poRes.body.items[0].id, quantityReceived: 10 }] });

  assert.equal(res.status, 201);
});
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
    [uniqueEmail('supplier-owner'), passwordHash]
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
      name: 'Supplier Test Ltd',
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

// --- Create ---

test('POST suppliers creates a supplier with contact details', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Bidfood', contactName: 'Jane Smith', phone: '02099998888', email: 'jane@bidfood.co.uk' });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Bidfood');
  assert.equal(res.body.contactName, 'Jane Smith');
});

test('POST suppliers requires a name', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ contactName: 'Jane Smith' });

  assert.equal(res.status, 400);
});

test('POST suppliers rejects an invalid email', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Bidfood', email: 'not-an-email' });

  assert.equal(res.status, 400);
});

// --- List / Get ---

test('GET suppliers lists suppliers for the shop', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Bidfood' });
  await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Brakes' });

  const res = await request(app).get(`/api/shops/${shopId}/suppliers`).set('Authorization', managerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('a supplier from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const managerHeaderA = await managerHeaderFor(ownerA.shopId);
  const supplier = await request(app)
    .post(`/api/shops/${ownerA.shopId}/suppliers`)
    .set('Authorization', managerHeaderA)
    .send({ name: 'Bidfood' });
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/suppliers/${supplier.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

// --- Update / Delete ---

test('PATCH suppliers updates contact details', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const supplier = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Bidfood' });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/suppliers/${supplier.body.id}`)
    .set('Authorization', managerHeader)
    .send({ phone: '02011112222', notes: 'Delivers Tuesdays and Fridays' });

  assert.equal(res.status, 200);
  assert.equal(res.body.phone, '02011112222');
  assert.equal(res.body.notes, 'Delivers Tuesdays and Fridays');
});

test('DELETE removes a supplier; it disappears from listings', async () => {
  const { shopId } = await setupOwnerWithShop();
  const managerHeader = await managerHeaderFor(shopId);
  const supplier = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', managerHeader)
    .send({ name: 'Bidfood' });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/suppliers/${supplier.body.id}`)
    .set('Authorization', managerHeader);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app).get(`/api/shops/${shopId}/suppliers`).set('Authorization', managerHeader);
  assert.equal(listRes.body.length, 0);
});
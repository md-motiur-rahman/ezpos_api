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
    [uniqueEmail('att-clock-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupShop(ownerUserId, { rotaEnabled = true } = {}) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Att Clock Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        rota_enabled, stripe_subscription_item_id)
     VALUES ($1, 'Att Clock Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2, $3)
     RETURNING id`,
    [companyRows[0].id, rotaEnabled, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return shopRows[0].id;
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

// --- Gate 1: rota_enabled ---

test('attendance endpoints are blocked with 400 when rota is not enabled', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId, { rotaEnabled: false });
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 400);
});

// --- Clock-in / clock-out ---

test('a staff member can clock in, creating an open record', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 201);
  assert.equal(res.body.staffId, server.id);
  assert.ok(res.body.clockedInAt);
  assert.equal(res.body.clockedOutAt, null);
});

test('clocking in while already clocked in is rejected with 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 409);
});

test('clocking out closes the open record', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-out`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.ok(res.body.clockedOutAt);
});

test('clocking out without an open record is rejected with 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-out`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 409);
});

test('the Owner cannot clock in - no staff row to attach a record to', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', header);

  assert.equal(res.status, 400);
});
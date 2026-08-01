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
    [uniqueEmail('att-cmp-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupShop(ownerUserId) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Att Cmp Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        rota_enabled, stripe_subscription_item_id)
     VALUES ($1, 'Att Cmp Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, true, $2)
     RETURNING id`,
    [companyRows[0].id, `si_test_${crypto.randomUUID().slice(0, 8)}`]
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

function iso(offsetHours) {
  return new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString();
}

async function insertShift(ownerHeader, shopId, staffId, startTime, endTime) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', ownerHeader)
    .send({ staffId, startTime, endTime });
  return res.body.id;
}

const RANGE = `from=${encodeURIComponent(iso(-2))}&to=${encodeURIComponent(iso(24))}`;

// --- 5.4: comparison ---

test('comparison classifies a shift with no attendance as no_show', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  await insertShift(header, shopId, server.id, iso(-1), iso(1));

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/comparison?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].status, 'no_show');
});

test('comparison classifies a completed clock-in/out overlapping the shift as completed', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  await insertShift(header, shopId, server.id, iso(-1), iso(1));
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-out`).set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/comparison?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.body[0].status, 'completed');
  assert.ok(res.body[0].clockedInAt);
  assert.ok(res.body[0].clockedOutAt);
});

test('comparison classifies an open clock-in overlapping the shift as in_progress', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  await insertShift(header, shopId, server.id, iso(-1), iso(1));
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/comparison?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.body[0].status, 'in_progress');
  assert.equal(res.body[0].clockedOutAt, null);
});

test('comparison classifies attendance with no matching shift as unscheduled', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  // No shift at all - just clocked in.
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/comparison?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].status, 'unscheduled');
  assert.equal(res.body[0].shiftId, null);
});

test('comparison requires manage_rota', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/comparison?${RANGE}`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 403);
});

// --- Cross-shop / auth ---

test('a shop the actor has no authority over returns 404, not another shop\'s data', async () => {
  const ownerA = await insertUser();
  const shopA = await setupShop(ownerA);
  const ownerB = await insertUser();
  await setupShop(ownerB);

  const res = await request(app)
    .get(`/api/shops/${shopA}/attendance?${RANGE}`)
    .set('Authorization', ownerHeaderFor(ownerB));

  assert.equal(res.status, 404);
});

test('attendance endpoints reject requests with no auth token', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app).get(`/api/shops/${shopId}/attendance?${RANGE}`);

  assert.equal(res.status, 401);
});
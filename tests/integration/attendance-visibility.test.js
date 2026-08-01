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
    [uniqueEmail('att-vis-owner'), passwordHash]
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
     VALUES ($1, 'Att Vis Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        rota_enabled, stripe_subscription_item_id)
     VALUES ($1, 'Att Vis Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, true, $2)
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

const RANGE = `from=${encodeURIComponent(iso(-2))}&to=${encodeURIComponent(iso(24))}`;

test('a Server can list their own attendance', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance?${RANGE}`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].staffId, server.id);
});

test('a Server requesting a different staffId is silently narrowed back to their own', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  const colleagueHeader = await staffHeaderFor(shopId, colleague.staffIdCode);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', colleagueHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance?${RANGE}&staffId=${colleague.id}`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].staffId, server.id); // NOT colleague.id
});

test('the Owner can list shop-wide attendance', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  const colleagueHeader = await staffHeaderFor(shopId, colleague.staffIdCode);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', serverHeader);
  await request(app).post(`/api/shops/${shopId}/attendance/clock-in`).set('Authorization', colleagueHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('viewing a specific record belonging to someone else is a 403, not silently narrowed', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const bystander = await insertStaff(shopId, 'chef');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  const bystanderHeader = await staffHeaderFor(shopId, bystander.staffIdCode);
  const created = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/${created.body.id}`)
    .set('Authorization', bystanderHeader);

  assert.equal(res.status, 403);
});

test('viewing your own specific record succeeds', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);
  const created = await request(app)
    .post(`/api/shops/${shopId}/attendance/clock-in`)
    .set('Authorization', serverHeader);

  const res = await request(app)
    .get(`/api/shops/${shopId}/attendance/${created.body.id}`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
});
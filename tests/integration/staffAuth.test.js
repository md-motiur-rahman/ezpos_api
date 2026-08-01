import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function setupStaff({ locked = false } = {}) {
  const { rows: userRows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, 'x', 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('login-owner')]
  );
  const subscriptionStatus = locked ? 'past_due' : 'active';
  const gracePeriodEndsAt = locked ? new Date(Date.now() - 24 * 60 * 60 * 1000) : null;
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id, subscription_status, grace_period_ends_at)
     VALUES ($1, 'Login Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'single',
             $2, $3, $4, $5)
     RETURNING id`,
    [
      userRows[0].id,
      `cus_test_${crypto.randomUUID().slice(0, 8)}`,
      `sub_test_${crypto.randomUUID().slice(0, 8)}`,
      subscriptionStatus,
      gracePeriodEndsAt,
    ]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        stripe_subscription_item_id)
     VALUES ($1, 'Login Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2)
     RETURNING id`,
    [companyRows[0].id, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = String(crypto.randomInt(10_000_000, 99_999_999));
  await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, 'Login Staff', 'chef', $2, $3)`,
    [shopRows[0].id, staffIdCode, pinHash]
  );

  return { shopId: shopRows[0].id, staffIdCode };
}

async function activeSessionCount(shopId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM staff_sessions ss
     JOIN staff s ON s.id = ss.staff_id
     WHERE s.shop_id = $1 AND ss.revoked_at IS NULL`,
    [shopId]
  );
  return rows[0].count;
}

// --- POST /api/staff-auth/login ---

test('login succeeds with the correct staff ID and PIN', async () => {
  const { shopId, staffIdCode } = await setupStaff();

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });

  assert.equal(res.status, 200);
  assert.ok(res.body.sessionToken);
  assert.equal(res.body.staff.role, 'chef');
  assert.equal(res.body.staff.shopId, shopId);
});

test('login with the wrong PIN and login with an unknown staff ID give identical errors', async () => {
  const { shopId, staffIdCode } = await setupStaff();

  const wrongPin = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: '99999999' });
  const unknownId = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode: '00000000', pin: KNOWN_PIN });

  assert.equal(wrongPin.status, 401);
  assert.equal(unknownId.status, 401);
  assert.equal(wrongPin.body.error.message, unknownId.body.error.message);
});

test('login rejects a staffIdCode that is not 8 digits', async () => {
  const { shopId } = await setupStaff();

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode: '123', pin: KNOWN_PIN });

  assert.equal(res.status, 400);
});

test('login is blocked with 402 when the company is billing-locked', async () => {
  const { shopId, staffIdCode } = await setupStaff({ locked: true });

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });

  assert.equal(res.status, 402);
});

// --- POST /api/staff-auth/logout ---

test('logout revokes the session', async () => {
  const { shopId, staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  assert.equal(await activeSessionCount(shopId), 1);

  const logoutRes = await request(app)
    .post('/api/staff-auth/logout')
    .send({ sessionToken: loginRes.body.sessionToken });

  assert.equal(logoutRes.status, 200);
  assert.equal(await activeSessionCount(shopId), 0);
});

test('logout with an already-invalid token is a no-op, not an error', async () => {
  const res = await request(app)
    .post('/api/staff-auth/logout')
    .send({ sessionToken: 'totally-bogus' });

  assert.equal(res.status, 200);
});

// --- Rate limiting ---

test('login is rate-limited after repeated attempts', async () => {
  const { shopId, staffIdCode } = await setupStaff();
  const attempt = () =>
    request(app).post('/api/staff-auth/login').send({ shopId, staffIdCode, pin: '00000000' });

  let lastStatus;
  for (let i = 0; i < 11; i += 1) {
    lastStatus = (await attempt()).status;
  }

  assert.equal(lastStatus, 429);
});


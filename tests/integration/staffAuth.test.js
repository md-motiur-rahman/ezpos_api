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

test('login succeeds with the correct staff ID and PIN, resolving the shop with no shopId in the request', async () => {
  const { shopId, staffIdCode } = await setupStaff();

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });

  assert.equal(res.status, 200);
  assert.ok(res.body.sessionToken);
  assert.equal(res.body.staff.role, 'chef');
  assert.equal(res.body.staff.shopId, shopId);
});

test('login with the wrong PIN and login with an unknown staff ID give identical errors', async () => {
  const { staffIdCode } = await setupStaff();

  const wrongPin = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: '99999999' });
  const unknownId = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode: '00000000', pin: KNOWN_PIN });

  assert.equal(wrongPin.status, 401);
  assert.equal(unknownId.status, 401);
  assert.equal(wrongPin.body.error.message, unknownId.body.error.message);
});

test('the same staffIdCode at two different shops each log in as their own staff member via their own distinct PIN', async () => {
  // The actual point of dropping shopId from the request: staff_id_code is
  // only unique PER SHOP, so two different shops legitimately having the
  // same code must still each resolve to the right one via the PIN - the
  // realistic case, since staffIdCode and pin are independently random and
  // it's the PIN that actually disambiguates in practice.
  const first = await setupStaff();
  const second = await setupStaff();
  const secondPin = '87654321';
  const secondPinHash = await bcrypt.hash(secondPin, 4); // low cost - tests only
  await query(`UPDATE staff SET staff_id_code = $1, pin_hash = $2 WHERE shop_id = $3`, [
    first.staffIdCode,
    secondPinHash,
    second.shopId,
  ]);

  const firstRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode: first.staffIdCode, pin: KNOWN_PIN });
  const secondRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode: first.staffIdCode, pin: secondPin });

  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.staff.shopId, first.shopId);
  assert.equal(secondRes.status, 200);
  assert.equal(secondRes.body.staff.shopId, second.shopId);
});

test('a login matching more than one staff record (same code AND same PIN, across shops) is refused rather than silently picking one', async () => {
  // Simulates the ~1-in-10^16 coincidence of two fully-random 8-digit
  // staffIdCode/pin pairs colliding across shops (staffAuth.service.js's own
  // doc explains why this can only happen by chance, never be engineered).
  // Refused rather than granting a session at an arbitrary one of the two -
  // the repository query defines no order, so "the first row back" is not a
  // real choice between two people, and silently authenticating as the
  // wrong shop's staff member is the worse failure mode.
  const first = await setupStaff();
  const second = await setupStaff();
  await query(`UPDATE staff SET staff_id_code = $1 WHERE shop_id = $2`, [
    first.staffIdCode,
    second.shopId,
  ]);

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode: first.staffIdCode, pin: KNOWN_PIN });

  assert.equal(res.status, 401);
  assert.equal(await activeSessionCount(first.shopId), 0);
  assert.equal(await activeSessionCount(second.shopId), 0);
});

test('login rejects a staffIdCode that is not 8 digits', async () => {
  await setupStaff();

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode: '123', pin: KNOWN_PIN });

  assert.equal(res.status, 400);
});

test('login is blocked with 402 when the company is billing-locked', async () => {
  const { staffIdCode } = await setupStaff({ locked: true });

  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });

  assert.equal(res.status, 402);
});

// --- POST /api/staff-auth/logout ---

test('logout revokes the session', async () => {
  const { shopId, staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
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
  const { staffIdCode } = await setupStaff();
  const attempt = () =>
    request(app).post('/api/staff-auth/login').send({ staffIdCode, pin: '00000000' });

  let lastStatus;
  for (let i = 0; i < 11; i += 1) {
    lastStatus = (await attempt()).status;
  }

  assert.equal(lastStatus, 429);
});

// --- POST /api/staff-auth/change-pin ---

test('change-pin rejects requests with no session token', async () => {
  const res = await request(app)
    .post('/api/staff-auth/change-pin')
    .send({ currentPin: KNOWN_PIN, newPin: '87654321' });

  assert.equal(res.status, 401);
});

test('change-pin succeeds with the correct current PIN, and the new PIN then logs in', async () => {
  const { staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  const newPin = '87654321';

  const res = await request(app)
    .post('/api/staff-auth/change-pin')
    .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
    .send({ currentPin: KNOWN_PIN, newPin });

  assert.equal(res.status, 200);

  const reLoginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: newPin });
  assert.equal(reLoginRes.status, 200);

  // The OLD PIN must no longer work.
  const oldPinRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  assert.equal(oldPinRes.status, 401);
});

test('change-pin revokes every session for this staff member, including the one making the request', async () => {
  const { shopId, staffIdCode } = await setupStaff();
  const firstSession = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  const secondSession = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  assert.equal(await activeSessionCount(shopId), 2);

  await request(app)
    .post('/api/staff-auth/change-pin')
    .set('Authorization', `Bearer ${firstSession.body.sessionToken}`)
    .send({ currentPin: KNOWN_PIN, newPin: '87654321' });

  assert.equal(await activeSessionCount(shopId), 0);

  // The second, unrelated session (a different device signed in as the same
  // staff member) is also revoked - not just the one that changed the PIN.
  const reuseRes = await request(app)
    .post('/api/staff-auth/logout')
    .send({ sessionToken: secondSession.body.sessionToken });
  assert.equal(reuseRes.status, 200); // logout of an already-revoked token is a no-op, not an error
});

test('change-pin rejects an incorrect current PIN and does not touch the real one', async () => {
  const { staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });

  const res = await request(app)
    .post('/api/staff-auth/change-pin')
    .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
    .send({ currentPin: '00000000', newPin: '87654321' });

  assert.equal(res.status, 401);

  // The original PIN still works - nothing was changed.
  const stillWorksRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  assert.equal(stillWorksRes.status, 200);
});

test('change-pin rejects a new PIN identical to the current one', async () => {
  const { staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });

  const res = await request(app)
    .post('/api/staff-auth/change-pin')
    .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
    .send({ currentPin: KNOWN_PIN, newPin: KNOWN_PIN });

  assert.equal(res.status, 400);
});

test('change-pin rejects a new PIN that is not 8 digits', async () => {
  const { staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });

  const res = await request(app)
    .post('/api/staff-auth/change-pin')
    .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
    .send({ currentPin: KNOWN_PIN, newPin: '123' });

  assert.equal(res.status, 400);
});

test('change-pin is rate-limited after repeated wrong-current-PIN attempts', async () => {
  const { staffIdCode } = await setupStaff();
  const loginRes = await request(app)
    .post('/api/staff-auth/login')
    .send({ staffIdCode, pin: KNOWN_PIN });
  const attempt = () =>
    request(app)
      .post('/api/staff-auth/change-pin')
      .set('Authorization', `Bearer ${loginRes.body.sessionToken}`)
      .send({ currentPin: '00000000', newPin: '87654321' });

  let lastStatus;
  for (let i = 0; i < 11; i += 1) {
    lastStatus = (await attempt()).status;
  }

  assert.equal(lastStatus, 429);
});


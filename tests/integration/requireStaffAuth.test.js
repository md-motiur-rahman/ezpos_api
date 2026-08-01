import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { requireStaffAuth } from '../../src/middleware/requireStaffAuth.js';

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

/** Company + shop + one active staff member, all seeded directly (no Stripe calls). */
async function setupStaff() {
  const { rows: userRows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, 'x', 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('staffauth-owner')]
  );
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'StaffAuth Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'single',
             $2, $3)
     RETURNING id`,
    [userRows[0].id, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        stripe_subscription_item_id)
     VALUES ($1, 'StaffAuth Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2)
     RETURNING id`,
    [companyRows[0].id, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = '10203040';
  const { rows: staffRows } = await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, 'Test Staff', 'server', $2, $3)
     RETURNING id`,
    [shopRows[0].id, staffIdCode, pinHash]
  );

  return { shopId: shopRows[0].id, staffId: staffRows[0].id, staffIdCode };
}

async function loginAsStaff({ shopId, staffIdCode }) {
  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  return res.body.sessionToken;
}

function buildReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

async function runMiddleware(token) {
  const req = buildReq(token);
  let nextError;
  await requireStaffAuth(req, {}, (err) => {
    nextError = err;
  });
  return { req, nextError };
}

// --- requireStaffAuth middleware ---

test('requireStaffAuth attaches req.staff for a valid session', async () => {
  const { shopId, staffId, staffIdCode } = await setupStaff();
  const token = await loginAsStaff({ shopId, staffIdCode });

  const { req, nextError } = await runMiddleware(token);

  assert.equal(nextError, undefined);
  assert.equal(req.staff.id, staffId);
  assert.equal(req.staff.role, 'server');
  assert.equal(req.staff.shopId, shopId);
});

test('requireStaffAuth rejects a missing Authorization header', async () => {
  const { nextError } = await runMiddleware(undefined);

  assert.equal(nextError.statusCode, 401);
});

test('requireStaffAuth rejects a garbage token', async () => {
  const { nextError } = await runMiddleware('totally-not-a-real-token');

  assert.equal(nextError.statusCode, 401);
});

test('requireStaffAuth rejects a session inactive for over 60 minutes', async () => {
  const { shopId, staffId, staffIdCode } = await setupStaff();
  const token = await loginAsStaff({ shopId, staffIdCode });
  await query(
    `UPDATE staff_sessions SET last_active_at = now() - interval '61 minutes' WHERE staff_id = $1`,
    [staffId]
  );

  const { nextError } = await runMiddleware(token);

  assert.equal(nextError.statusCode, 401);
});

test('requireStaffAuth rejects a session for a deactivated staff member', async () => {
  const { shopId, staffId, staffIdCode } = await setupStaff();
  const token = await loginAsStaff({ shopId, staffIdCode });
  await query(`UPDATE staff SET deleted_at = now() WHERE id = $1`, [staffId]);

  const { nextError } = await runMiddleware(token);

  assert.equal(nextError.statusCode, 401);
});

test('requireStaffAuth slides the session window forward on a valid request', async () => {
  const { shopId, staffId, staffIdCode } = await setupStaff();
  const token = await loginAsStaff({ shopId, staffIdCode });
  await query(
    `UPDATE staff_sessions SET last_active_at = now() - interval '30 minutes' WHERE staff_id = $1`,
    [staffId]
  );
  const { rows: before } = await query(
    `SELECT last_active_at FROM staff_sessions WHERE staff_id = $1`,
    [staffId]
  );

  await runMiddleware(token);

  const { rows: after } = await query(
    `SELECT last_active_at FROM staff_sessions WHERE staff_id = $1`,
    [staffId]
  );
  assert.ok(new Date(after[0].last_active_at) > new Date(before[0].last_active_at));
});
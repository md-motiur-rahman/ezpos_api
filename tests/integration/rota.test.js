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
    [uniqueEmail('rota-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

/** rotaEnabled defaults true unless explicitly overridden. */
async function setupShop(ownerUserId, { rotaEnabled = true } = {}) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Rota Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        rota_enabled, stripe_subscription_item_id)
     VALUES ($1, 'Rota Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2, $3)
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

async function grantPermission(ownerUserId, targetStaffId, permission) {
  await request(app)
    .post(`/api/staff-permissions/${targetStaffId}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission });
}

function iso(offsetHours) {
  return new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString();
}

const RANGE = `from=${encodeURIComponent(iso(-24))}&to=${encodeURIComponent(iso(24 * 7))}`;

// --- Gate 1: rota_enabled ---

test('all rota endpoints are blocked with 400 when rota is not enabled for the shop', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId, { rotaEnabled: false });
  const staff = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: staff.id, startTime: iso(1), endTime: iso(5) });
  assert.equal(createRes.status, 400);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts?${RANGE}`)
    .set('Authorization', header);
  assert.equal(listRes.status, 400);
});

// --- Gate 2: manage_rota, per confirmed spec ---

test('a Manager (default manage_rota) can create a shift', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'server');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', managerHeader)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  assert.equal(res.status, 201);
  assert.equal(res.body.staffId, target.id);
});

test('a Server (no manage_rota) is blocked from creating a shift', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', serverHeader)
    .send({ staffId: server.id, startTime: iso(1), endTime: iso(5) });

  assert.equal(res.status, 403);
});

test('a Shift Manager can create a shift once granted manage_rota', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const target = await insertStaff(shopId, 'server');
  await grantPermission(ownerUserId, shiftManager.id, 'manage_rota');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', shiftManagerHeader)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  assert.equal(res.status, 201);
});

// --- Reads stay open (only gate 1, not gate 2) ---

test('a Server (no manage_rota) can still read the rota', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts?${RANGE}`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
});

// --- Validity checks ---

test('creating a shift with endTime before startTime is rejected', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ staffId: target.id, startTime: iso(5), endTime: iso(1) });

  assert.equal(res.status, 400);
});

test('an overlapping shift for the same staff member is rejected with 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);

  await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(3), endTime: iso(7) }); // overlaps

  assert.equal(res.status, 409);
});

test('non-overlapping shifts for the same staff member are both allowed', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);

  await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(6), endTime: iso(10) }); // no overlap

  assert.equal(res.status, 201);
});

test('scheduling a staff member from a different shop is rejected', async () => {
  const ownerA = await insertUser();
  const shopA = await setupShop(ownerA);
  const ownerB = await insertUser();
  const shopB = await setupShop(ownerB);
  const staffInB = await insertStaff(shopB, 'server');

  const res = await request(app)
    .post(`/api/shops/${shopA}/rota-shifts`)
    .set('Authorization', ownerHeaderFor(ownerA))
    .send({ staffId: staffInB.id, startTime: iso(1), endTime: iso(5) });

  assert.equal(res.status, 404);
});

test('scheduling a deactivated staff member is rejected', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);
  await request(app).delete(`/api/shops/${shopId}/staff/${target.id}`).set('Authorization', header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  assert.equal(res.status, 404);
});

// --- GET list with date range ---

test('listing filters shifts to the given date range', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);

  await request(app) // inside the default RANGE
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });
  await request(app) // far outside the default RANGE
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(24 * 30), endTime: iso(24 * 30 + 4) });

  const res = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts?${RANGE}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('listing requires both from and to', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts?from=${encodeURIComponent(iso(0))}`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 400);
});

// --- PATCH / DELETE ---

test('updating a shift re-checks overlap against the new time', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);

  await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });
  const second = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(6), endTime: iso(10) });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/rota-shifts/${second.body.id}`)
    .set('Authorization', header)
    .send({ startTime: iso(2), endTime: iso(4) }); // now overlaps the first

  assert.equal(res.status, 409);
});

test('updating a shift to a valid new time succeeds', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);
  const created = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/rota-shifts/${created.body.id}`)
    .set('Authorization', header)
    .send({ notes: 'covering for a colleague' });

  assert.equal(res.status, 200);
  assert.equal(res.body.notes, 'covering for a colleague');
});

test('deleting a shift removes it from subsequent listings', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  const header = ownerHeaderFor(ownerUserId);
  const created = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', header)
    .send({ staffId: target.id, startTime: iso(1), endTime: iso(5) });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/rota-shifts/${created.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts?${RANGE}`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

// --- Cross-shop / auth ---

test('a shift from another shop returns 404', async () => {
  const ownerA = await insertUser();
  const shopA = await setupShop(ownerA);
  const targetA = await insertStaff(shopA, 'server');
  const created = await request(app)
    .post(`/api/shops/${shopA}/rota-shifts`)
    .set('Authorization', ownerHeaderFor(ownerA))
    .send({ staffId: targetA.id, startTime: iso(1), endTime: iso(5) });

  const ownerB = await insertUser();
  const shopB = await setupShop(ownerB);

  const res = await request(app)
    .get(`/api/shops/${shopB}/rota-shifts/${created.body.id}`)
    .set('Authorization', ownerHeaderFor(ownerB));

  assert.equal(res.status, 404);
});

test('rota endpoints reject requests with no auth token', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app).get(`/api/shops/${shopId}/rota-shifts?${RANGE}`);

  assert.equal(res.status, 401);
});
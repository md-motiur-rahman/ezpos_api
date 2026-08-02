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
    [uniqueEmail('swap-owner'), passwordHash]
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
     VALUES ($1, 'Swap Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        rota_enabled, stripe_subscription_item_id)
     VALUES ($1, 'Swap Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2, $3)
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

function iso(offsetHours) {
  return new Date(Date.now() + offsetHours * 60 * 60 * 1000).toISOString();
}

/** Creates a shift directly via the owner (bypasses actor-permission concerns in setup). */
async function insertShift(ownerHeader, shopId, staffId, startTime, endTime) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/rota-shifts`)
    .set('Authorization', ownerHeader)
    .send({ staffId, startTime, endTime });
  return res.body.id;
}

// --- Gate 1: rota_enabled ---

test('swap request endpoints are blocked with 400 when rota is not enabled', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId, { rotaEnabled: false });
  const header = ownerHeaderFor(ownerUserId);

  const res = await request(app)
    .get(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header);

  assert.equal(res.status, 400);
});

// --- Create: self-service vs manager-initiated ---

test('the shift owner can self-service request a swap without manage_rota', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', serverHeader)
    .send({ shiftId, toStaffId: colleague.id });

  console.log('shiftId was:', shiftId);
  console.log('response body:', res.body);

  assert.equal(res.status, 201);

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.fromStaffId, server.id);
  assert.equal(res.body.requestedByType, 'staff');
  assert.equal(res.body.requestedById, server.id);
});

test('a Manager can request a swap on someone else\'s shift', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', managerHeader)
    .send({ shiftId, toStaffId: colleague.id });

  assert.equal(res.status, 201);
  assert.equal(res.body.requestedByType, 'staff');
  assert.equal(res.body.requestedById, manager.id);
});

test('an unrelated staff member with no manage_rota cannot request a swap on someone else\'s shift', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const bystander = await insertStaff(shopId, 'chef');
  const colleague = await insertStaff(shopId, 'server');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const bystanderHeader = await staffHeaderFor(shopId, bystander.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', bystanderHeader)
    .send({ shiftId, toStaffId: colleague.id });

  assert.equal(res.status, 403);
});

// --- Create: validation ---

test('toStaffId equal to the current staff member is rejected', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: server.id });

  assert.equal(res.status, 400);
});

test('toStaffId for a deactivated staff member is rejected', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  await request(app).delete(`/api/shops/${shopId}/staff/${colleague.id}`).set('Authorization', header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });

  assert.equal(res.status, 404);
});

test('a duplicate pending request for the same shift is rejected with 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleagueA = await insertStaff(shopId, 'chef');
  const colleagueB = await insertStaff(shopId, 'server');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));

  await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleagueA.id });

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleagueB.id });

  assert.equal(res.status, 409);
});

// --- Approve ---

test('approving reassigns the shift to the nominated staff member', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/approve`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.decidedByType, 'owner');

  const shiftRes = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts/${shiftId}`)
    .set('Authorization', header);
  assert.equal(shiftRes.body.staffId, colleague.id);
});

test('approving reuses 5.1\'s overlap check - rejects if the nominee now has a conflicting shift', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });

  // Colleague picks up a conflicting shift AFTER the swap was requested.
  await insertShift(header, shopId, colleague.id, iso(2), iso(6));

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/approve`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

test('approving without manage_rota is blocked', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/approve`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 403);
});

test('approving a shift that was already reassigned some other way is rejected', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const thirdParty = await insertStaff(shopId, 'server');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });

  // Shift directly reassigned to someone else via PATCH, bypassing the swap flow.
  await request(app)
    .patch(`/api/shops/${shopId}/rota-shifts/${shiftId}`)
    .set('Authorization', header)
    .send({ staffId: thirdParty.id });

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/approve`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

// --- Reject ---

test('rejecting leaves the shift untouched', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/reject`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'rejected');

  const shiftRes = await request(app)
    .get(`/api/shops/${shopId}/rota-shifts/${shiftId}`)
    .set('Authorization', header);
  assert.equal(shiftRes.body.staffId, server.id); // unchanged
});

// --- Already-decided requests ---

test('approving an already-decided request returns 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });
  await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/reject`)
    .set('Authorization', header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${created.body.id}/approve`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

// --- List / read access ---

test('a Server (no manage_rota) can still list swap requests', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleague = await insertStaff(shopId, 'chef');
  const shiftId = await insertShift(header, shopId, server.id, iso(1), iso(5));
  await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId, toStaffId: colleague.id });
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('listing filters by status', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const header = ownerHeaderFor(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const colleagueA = await insertStaff(shopId, 'chef');
  const colleagueB = await insertStaff(shopId, 'server');
  const shiftA = await insertShift(header, shopId, server.id, iso(1), iso(5));
  const shiftB = await insertShift(header, shopId, colleagueB.id, iso(10), iso(14));
  const first = await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId: shiftA, toStaffId: colleagueA.id });
  await request(app)
    .post(`/api/shops/${shopId}/swap-requests`)
    .set('Authorization', header)
    .send({ shiftId: shiftB, toStaffId: colleagueA.id });
  await request(app)
    .post(`/api/shops/${shopId}/swap-requests/${first.body.id}/reject`)
    .set('Authorization', header);

  const res = await request(app)
    .get(`/api/shops/${shopId}/swap-requests?status=pending`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].status, 'pending');
});

// --- Cross-shop / auth ---

test('a swap request from another shop returns 404', async () => {
  const ownerA = await insertUser();
  const shopA = await setupShop(ownerA);
  const headerA = ownerHeaderFor(ownerA);
  const serverA = await insertStaff(shopA, 'server');
  const colleagueA = await insertStaff(shopA, 'chef');
  const shiftA = await insertShift(headerA, shopA, serverA.id, iso(1), iso(5));
  const created = await request(app)
    .post(`/api/shops/${shopA}/swap-requests`)
    .set('Authorization', headerA)
    .send({ shiftId: shiftA, toStaffId: colleagueA.id });

  const ownerB = await insertUser();
  const shopB = await setupShop(ownerB);

  const res = await request(app)
    .get(`/api/shops/${shopB}/swap-requests/${created.body.id}`)
    .set('Authorization', ownerHeaderFor(ownerB));

  assert.equal(res.status, 404);
});

test('swap request endpoints reject requests with no auth token', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app).get(`/api/shops/${shopId}/swap-requests`);

  assert.equal(res.status, 401);
});
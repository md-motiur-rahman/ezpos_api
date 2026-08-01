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
    [uniqueEmail('hier-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function insertShopForCompany(companyId) {
  const { rows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        stripe_subscription_item_id)
     VALUES ($1, 'Hier Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2)
     RETURNING id`,
    [companyId, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return rows[0].id;
}

async function setupShop(ownerUserId) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Hier Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return { companyId: companyRows[0].id, shopId: await insertShopForCompany(companyRows[0].id) };
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

// --- Creation: rank ceiling ---

test('a Manager can create a Shift Manager, Server, and Chef', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  for (const role of ['shift_manager', 'server', 'chef']) {
    const res = await request(app)
      .post(`/api/shops/${shopId}/staff`)
      .set('Authorization', managerHeader)
      .send({ fullName: `New ${role}`, role });
    assert.equal(res.status, 201, `expected 201 creating a ${role}`);
  }
});

test('a Manager cannot create another Manager', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', managerHeader)
    .send({ fullName: 'Rival Manager', role: 'manager' });

  assert.equal(res.status, 403);
});

test('an empowered Shift Manager can create a Server or Chef but not another Shift Manager', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  await grantPermission(ownerUserId, shiftManager.id, 'manage_staff');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const serverRes = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', shiftManagerHeader)
    .send({ fullName: 'New Server', role: 'server' });
  assert.equal(serverRes.status, 201);

  const peerRes = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', shiftManagerHeader)
    .send({ fullName: 'Rival Shift Manager', role: 'shift_manager' });
  assert.equal(peerRes.status, 403);
});

test('a Server (no manage_staff by default) cannot create staff at all', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', serverHeader)
    .send({ fullName: 'New Chef', role: 'chef' });

  assert.equal(res.status, 403);
});

test('creating staff in a shop the actor has no authority over returns 404', async () => {
  const ownerA = await insertUser();
  const { shopId: shopA } = await setupShop(ownerA);
  const managerA = await insertStaff(shopA, 'manager');
  const managerAHeader = await staffHeaderFor(shopA, managerA.staffIdCode);

  const ownerB = await insertUser();
  const { shopId: shopB } = await setupShop(ownerB);

  const res = await request(app)
    .post(`/api/shops/${shopB}/staff`)
    .set('Authorization', managerAHeader)
    .send({ fullName: 'Cross Shop', role: 'server' });

  assert.equal(res.status, 404);
});

// --- Update: rank ceiling on both target and new role ---

test('a Manager cannot promote a Shift Manager to Manager', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'shift_manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/staff/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ role: 'manager' });

  assert.equal(res.status, 403);
});

test('a Manager can update a Shift Manager to Server (staying below their rank)', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'shift_manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/staff/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ role: 'server' });

  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'server');
});

test('a Shift Manager cannot update a Manager, even with manage_staff', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  await grantPermission(ownerUserId, shiftManager.id, 'manage_staff');
  const manager = await insertStaff(shopId, 'manager');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/staff/${manager.id}`)
    .set('Authorization', shiftManagerHeader)
    .send({ fullName: 'Renamed' });

  assert.equal(res.status, 403);
});
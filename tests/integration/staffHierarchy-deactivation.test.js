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

// --- Deactivation: rank ceiling + self-deactivation ---

test('a Manager can deactivate a Server', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'server');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/staff/${target.id}`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 200);
});

test('a Manager cannot deactivate another Manager', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const managerA = await insertStaff(shopId, 'manager');
  const managerB = await insertStaff(shopId, 'manager');
  const managerAHeader = await staffHeaderFor(shopId, managerA.staffIdCode);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/staff/${managerB.id}`)
    .set('Authorization', managerAHeader);

  assert.equal(res.status, 403);
});

test('a Manager cannot deactivate themselves (self-deactivation blocked)', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/staff/${manager.id}`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 403);
});

// --- Reads stay open regardless of manage_staff ---

test('a Server (no manage_staff) can still list and view staff in their own shop', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const other = await insertStaff(shopId, 'chef');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const listRes = await request(app).get(`/api/shops/${shopId}/staff`).set('Authorization', serverHeader);
  assert.equal(listRes.status, 200);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/staff/${other.id}`)
    .set('Authorization', serverHeader);
  assert.equal(getRes.status, 200);
});

// --- Owner retains full access (regression check) ---

test('the Owner can still create, update, and deactivate any staff member', async () => {
  const ownerUserId = await insertUser();
  const { shopId } = await setupShop(ownerUserId);

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/staff`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ fullName: 'Owner Made Manager', role: 'manager' });
  assert.equal(createRes.status, 201);

  const updateRes = await request(app)
    .patch(`/api/shops/${shopId}/staff/${createRes.body.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ role: 'shift_manager' });
  assert.equal(updateRes.status, 200);

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/staff/${createRes.body.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId));
  assert.equal(deleteRes.status, 200);
});
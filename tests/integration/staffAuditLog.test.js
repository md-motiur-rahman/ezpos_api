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
    [uniqueEmail('audit-owner'), passwordHash]
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
     VALUES ($1, 'Audit Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone, vat_registered,
        stripe_subscription_item_id)
     VALUES ($1, 'Audit Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2)
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

// --- Grant/revoke attribution (the core fix) ---

test('a staff-initiated grant is recorded with the correct actor', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'server');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ permission: 'access_till' });

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  const entry = res.body.find((e) => e.staffId === target.id);
  assert.equal(entry.grantedByType, 'staff');
  assert.equal(entry.grantedById, manager.id);
  assert.equal(entry.revokedAt, null);
});

test('a revoke is recorded with the correct actor', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'server');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ permission: 'access_till' });
  await request(app)
    .delete(`/api/staff-permissions/${target.id}/access_till`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  const entry = res.body.find((e) => e.staffId === target.id);
  assert.equal(entry.grantedByType, 'staff'); // grant attribution preserved
  assert.equal(entry.grantedById, manager.id);
  assert.equal(entry.revokedByType, 'owner'); // revoke attribution recorded
  assert.equal(entry.revokedById, ownerUserId);
  assert.ok(entry.revokedAt);
});

// --- Log completeness ---

test('the log includes both active and revoked entries, newest first', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');

  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'access_till' });
  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'view_inventory' });
  await request(app)
    .delete(`/api/staff-permissions/${target.id}/access_till`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  // Newest first.
  assert.equal(res.body[0].permission, 'view_inventory');
  assert.equal(res.body[1].permission, 'access_till');
  assert.ok(res.body[1].revokedAt); // the revoked one still shows up
});

test('the log includes entries for a since-deactivated staff member', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');

  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'access_till' });
  await request(app)
    .delete(`/api/shops/${shopId}/staff/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].staffId, target.id);
});

// --- Access control ---

test('viewing the audit log requires grant_permissions', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 403);
});

test('the audit log for a shop the actor has no authority over returns 404', async () => {
  const ownerA = await insertUser();
  await setupShop(ownerA);
  const ownerB = await insertUser();
  const shopB = await setupShop(ownerB);

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopB}/audit-log`)
    .set('Authorization', ownerHeaderFor(ownerA));

  assert.equal(res.status, 404);
});

test('the audit log rejects requests with no auth token', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app).get(`/api/staff-permissions/shop/${shopId}/audit-log`);

  assert.equal(res.status, 401);
});

// --- limit validation (shared schema from 3.7) ---

test('the audit log rejects a limit of 0', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log?limit=0`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 400);
});

test('the audit log rejects a limit over 100', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log?limit=101`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 400);
});

test('the audit log respects a custom limit', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');

  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'access_till' });
  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'view_inventory' });

  const res = await request(app)
    .get(`/api/staff-permissions/shop/${shopId}/audit-log?limit=1`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});
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
    [uniqueEmail('perm-owner'), passwordHash]
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
     VALUES ($1, 'Perm Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', true, $2)
     RETURNING id`,
    [companyId, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return rows[0].id;
}

/** Company + shop, all seeded directly (no Stripe calls needed for this module). */
async function setupShop(ownerUserId) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Perm Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return insertShopForCompany(companyRows[0].id);
}

/** Returns { shopId, companyId } - used when a test needs a second shop on the same company. */
async function setupCompanyWithShop(ownerUserId) {
  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone, business_type,
        stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Perm Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567', 'chain',
             $2, $3)
     RETURNING id`,
    [ownerUserId, `cus_test_${crypto.randomUUID().slice(0, 8)}`, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const companyId = companyRows[0].id;
  const shopId = await insertShopForCompany(companyId);
  return { companyId, shopId };
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

async function activeOverrides(staffId) {
  const { rows } = await query(
    `SELECT permission FROM staff_permission_overrides WHERE staff_id = $1 AND revoked_at IS NULL`,
    [staffId]
  );
  return rows.map((r) => r.permission);
}

// --- Auth guard ---

test('permission endpoints reject requests with no auth token', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 401);
});

// --- Owner as actor ---

test('the Owner can grant any permission to any staff member', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 201);
  assert.deepEqual(await activeOverrides(target.id), ['manage_inventory']);
});

test('the Owner can revoke any permission from any staff member', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');
  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'manage_inventory' });

  const res = await request(app)
    .delete(`/api/staff-permissions/${target.id}/manage_inventory`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  assert.deepEqual(await activeOverrides(target.id), []);
});

test('the Owner acting on a staff member from another company gets 404', async () => {
  const ownerA = await insertUser();
  const shopA = await setupShop(ownerA);
  const ownerB = await insertUser();
  await setupShop(ownerB);
  const target = await insertStaff(shopA, 'shift_manager');

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerB))
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 404);
});

// --- Staff as actor ---

test('a Manager can grant a permission they hold to a Shift Manager', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'shift_manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  // Manager has manage_inventory by default (4.1).
  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 201);
  assert.equal(res.body.grantedBy, manager.id);
});

test('a Manager cannot grant a permission they do not hold themselves', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const manager = await insertStaff(shopId, 'manager');
  const target = await insertStaff(shopId, 'shift_manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  // Manager does NOT have request_stock_order by default (4.1).
  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', managerHeader)
    .send({ permission: 'request_stock_order' });

  assert.equal(res.status, 403);
});

test('a Shift Manager without grant_permissions cannot grant anything', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const target = await insertStaff(shopId, 'server');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', shiftManagerHeader)
    .send({ permission: 'access_till' });

  assert.equal(res.status, 403);
});

test('a Shift Manager granted grant_permissions and manage_inventory can then grant manage_inventory onward', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const target = await insertStaff(shopId, 'server');

  // Owner empowers the Shift Manager first.
  await request(app)
    .post(`/api/staff-permissions/${shiftManager.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'grant_permissions' });
  await request(app)
    .post(`/api/staff-permissions/${shiftManager.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'manage_inventory' });

  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);
  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', shiftManagerHeader)
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 201);
});

test('a Shift Manager cannot manage permissions for a Manager (equal-or-higher rank)', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const manager = await insertStaff(shopId, 'manager');
  await request(app)
    .post(`/api/staff-permissions/${shiftManager.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'grant_permissions' });
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .post(`/api/staff-permissions/${manager.id}`)
    .set('Authorization', shiftManagerHeader)
    .send({ permission: 'access_till' });

  assert.equal(res.status, 403);
});

test('a Server and a Chef cannot manage permissions for each other (equal rank, tie)', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const server = await insertStaff(shopId, 'server');
  const chef = await insertStaff(shopId, 'chef');
  await request(app)
    .post(`/api/staff-permissions/${server.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'grant_permissions' });
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/staff-permissions/${chef.id}`)
    .set('Authorization', serverHeader)
    .send({ permission: 'access_till' });

  assert.equal(res.status, 403);
});

test('staff cannot manage permissions for staff in a different shop', async () => {
  const ownerUserId = await insertUser();
  const { companyId, shopId: shopA } = await setupCompanyWithShop(ownerUserId);
  const shopB = await insertShopForCompany(companyId);
  const managerA = await insertStaff(shopA, 'manager');
  const targetB = await insertStaff(shopB, 'server');
  const managerAHeader = await staffHeaderFor(shopA, managerA.staffIdCode);

  const res = await request(app)
    .post(`/api/staff-permissions/${targetB.id}`)
    .set('Authorization', managerAHeader)
    .send({ permission: 'access_till' });

  assert.equal(res.status, 404);
});

// --- Idempotency / not-found ---

test('granting an already-active permission returns 409', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');
  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'manage_inventory' });

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'manage_inventory' });

  assert.equal(res.status, 409);
});

test('revoking a permission that is not currently active returns 404', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');

  const res = await request(app)
    .delete(`/api/staff-permissions/${target.id}/manage_inventory`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 404);
});

test('granting an unknown permission value returns 400', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'shift_manager');

  const res = await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'time_travel' });

  assert.equal(res.status, 400);
});

// --- Effective permissions list ---

test('GET effective permissions unions role defaults with active overrides', async () => {
  const ownerUserId = await insertUser();
  const shopId = await setupShop(ownerUserId);
  const target = await insertStaff(shopId, 'server');
  await request(app)
    .post(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId))
    .send({ permission: 'view_inventory' });

  const res = await request(app)
    .get(`/api/staff-permissions/${target.id}`)
    .set('Authorization', ownerHeaderFor(ownerUserId));

  assert.equal(res.status, 200);
  assert.equal(res.body.role, 'server');
  assert.ok(res.body.permissions.includes('access_till')); // default
  assert.ok(res.body.permissions.includes('perform_health_safety')); // default
  assert.ok(res.body.permissions.includes('view_inventory')); // override
  assert.ok(!res.body.permissions.includes('manage_staff')); // neither
});
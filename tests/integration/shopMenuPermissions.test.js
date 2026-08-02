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
    [uniqueEmail('menuperm-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Menu Perm Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'chain' });
  const shopRes = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Test Shop',
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: true,
    });
  return { userId, header, shopId: shopRes.body.id };
}

async function createCategory(header) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  return res.body;
}

async function createMasterItem(header, categoryId) {
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId, name: 'Chicken Nuggets', price: 4.99 });
  return res.body;
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

// --- Manager (default manage_menu) ---

test('a Manager can set an override', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', managerHeader)
    .send({ isEnabled: false });

  assert.equal(res.status, 200);
});

test('a Manager can create a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', managerHeader)
    .send({ categoryId: category.id, name: 'Wrap', price: 6.5 });

  assert.equal(res.status, 201);
});

// --- Server / Chef (no manage_menu) ---

test('a Server cannot set an override, but can still read the menu', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const patchRes = await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', serverHeader)
    .send({ isEnabled: false });
  assert.equal(patchRes.status, 403);

  const getRes = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', serverHeader);
  assert.equal(getRes.status, 200);
});

test('a Chef cannot create a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', chefHeader)
    .send({ categoryId: category.id, name: 'Wrap', price: 6.5 });

  assert.equal(res.status, 403);
});

// --- Empowered Shift Manager ---

test('a Shift Manager can set an override once granted manage_menu', async () => {
  const { userId, header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);
  const shiftManager = await insertStaff(shopId, 'shift_manager');
  await grantPermission(userId, shiftManager.id, 'manage_menu');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', shiftManagerHeader)
    .send({ isEnabled: false });

  assert.equal(res.status, 200);
});
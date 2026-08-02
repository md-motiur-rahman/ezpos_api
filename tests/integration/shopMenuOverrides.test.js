import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('shopmenu-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

/** Owner + company + one shop, ready for menu tests. Returns { header, shopId }. */
async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Shop Menu Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });
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
  return { header, shopId: shopRes.body.id };
}

async function createCategory(header) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  return res.body;
}

async function createMasterItem(header, categoryId, overrides = {}) {
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId, name: 'Chicken Nuggets', price: 4.99, ...overrides });
  return res.body;
}

// --- Auth guard ---

test('shop menu endpoints reject requests with no auth token', async () => {
  const { shopId } = await setupOwnerWithShop();
  const res = await request(app).get(`/api/shops/${shopId}/menu`);
  assert.equal(res.status, 401);
});

// --- Override upsert ---

test('setting isEnabled on an override creates it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.isEnabled, false);
  assert.equal(res.body.priceOverride, null);
});

test('setting priceOverride independently does not touch isEnabled', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);

  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ priceOverride: 3.99 });

  assert.equal(res.status, 200);
  assert.equal(res.body.priceOverride, 3.99);
  assert.equal(res.body.isEnabled, false); // untouched by the second PATCH
});

test('PATCH override on a menu item from another company returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const categoryA = await createCategory(ownerA.header);
  const itemA = await createMasterItem(ownerA.header, categoryA.id);
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .patch(`/api/shops/${ownerB.shopId}/menu/overrides/${itemA.id}`)
    .set('Authorization', ownerB.header)
    .send({ isEnabled: false });

  assert.equal(res.status, 404);
});

test('DELETE override reverts the item to master defaults', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id, { price: 4.99 });
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false, priceOverride: 3.99 });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const menuRes = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);
  const resolved = menuRes.body.find((entry) => entry.id === item.id);
  assert.equal(resolved.isEnabled, true);
  assert.equal(resolved.price, 4.99);
});

// --- Resolved GET /menu ---

test('GET /menu resolves master items with no override to master defaults', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id, { price: 4.99 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  assert.equal(res.status, 200);
  const resolved = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolved.source, 'master');
  assert.equal(resolved.price, 4.99);
  assert.equal(resolved.masterPrice, 4.99);
  assert.equal(resolved.isEnabled, true);
});

test('GET /menu applies an active price override', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id, { price: 4.99 });
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ priceOverride: 3.99 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolved = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolved.price, 3.99);
  assert.equal(resolved.masterPrice, 4.99); // original master price still visible
});

test('GET /menu shows a disabled item as disabled, not hidden', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await createMasterItem(header, category.id);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${item.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  assert.equal(res.body.length, 1); // still present
  assert.equal(res.body[0].isEnabled, false);
});

test('GET /menu includes local items tagged as source local', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  await createMasterItem(header, category.id, { name: 'Chicken Nuggets' });
  await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Chicken Falafel Wrap', price: 6.5 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  assert.equal(res.body.length, 2);
  const master = res.body.find((entry) => entry.name === 'Chicken Nuggets');
  const local = res.body.find((entry) => entry.name === 'Chicken Falafel Wrap');
  assert.equal(master.source, 'master');
  assert.equal(local.source, 'local');
  assert.equal(local.masterPrice, null);
});

test('a shop the actor has no authority over returns 404 for the menu view', async () => {
  const ownerA = await setupOwnerWithShop();
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerA.shopId}/menu`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});
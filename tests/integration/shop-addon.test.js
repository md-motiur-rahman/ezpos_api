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
    [uniqueEmail('owner'), passwordHash]
  );
  return rows[0].id;
}

function authHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Test Restaurant Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

const VALID_SHOP = {
  name: 'Test Shop',
  addressLine1: '2 Market Street',
  city: 'London',
  postcode: 'E1 1AA',
  country: 'UK',
  phone: '02011112222',
  vatRegistered: true,
};

/** Owner + company + business type + one shop, ready for add-on tests. */
async function setupShop(businessType = 'chain') {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType });
  const shopRes = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  return { userId, header, shopId: shopRes.body.id };
}

async function addonRows(shopId) {
  const { rows } = await query(
    `SELECT addon_type, stripe_subscription_item_id, deleted_at
     FROM shop_addons WHERE shop_id = $1 ORDER BY created_at`,
    [shopId]
  );
  return rows;
}

// --- Auth guard ---

test('add-on endpoints reject requests with no auth token', async () => {
  const { shopId } = await setupShop();

  const postRes = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .send({ addonType: 'health_safety' });
  const getRes = await request(app).get(`/api/shops/${shopId}/addons`);

  assert.equal(postRes.status, 401);
  assert.equal(getRes.status, 401);
});

// --- POST /api/shops/:shopId/addons ---

test('POST addons activates the add-on and creates a billing line item', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 201);
  assert.equal(res.body.addonType, 'health_safety');

  const rows = await addonRows(shopId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].stripe_subscription_item_id.startsWith('si_test_'));
});

test('POST addons rejects activating the same add-on twice', async () => {
  const { header, shopId } = await setupShop();

  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });
  const res = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 409);
});

test('POST addons rejects an unknown addonType', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'time_travel' });

  assert.equal(res.status, 400);
});

test('POST addons returns 404 for a shop belonging to another company', async () => {
  const ownerA = await setupShop();
  const ownerB = await setupShop();

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/addons`)
    .set('Authorization', ownerB.header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 404);
});

test('POST addons returns 400 for a malformed shop id', async () => {
  const { header } = await setupShop();

  const res = await request(app)
    .post('/api/shops/not-a-uuid/addons')
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 400);
});

// --- GET /api/shops/:shopId/addons ---

test('GET addons lists only active add-ons for that shop', async () => {
  const { header, shopId } = await setupShop();

  const emptyRes = await request(app).get(`/api/shops/${shopId}/addons`).set('Authorization', header);
  assert.equal(emptyRes.body.length, 0);

  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  const res = await request(app).get(`/api/shops/${shopId}/addons`).set('Authorization', header);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].addonType, 'health_safety');
});

// --- DELETE /api/shops/:shopId/addons/:addonType ---

test('DELETE addons deactivates and removes it from the active list', async () => {
  const { header, shopId } = await setupShop();
  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  const res = await request(app)
    .delete(`/api/shops/${shopId}/addons/health_safety`)
    .set('Authorization', header);
  assert.equal(res.status, 200);

  const listRes = await request(app).get(`/api/shops/${shopId}/addons`).set('Authorization', header);
  assert.equal(listRes.body.length, 0);

  const rows = await addonRows(shopId);
  assert.ok(rows[0].deleted_at); // soft-deleted, history preserved
});

test('DELETE addons returns 404 when the add-on is not active', async () => {
  const { header, shopId } = await setupShop();

  const res = await request(app)
    .delete(`/api/shops/${shopId}/addons/health_safety`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

test('an add-on can be reactivated after being deactivated', async () => {
  const { header, shopId } = await setupShop();

  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });
  await request(app).delete(`/api/shops/${shopId}/addons/health_safety`).set('Authorization', header);
  const res = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 201);

  const rows = await addonRows(shopId);
  assert.equal(rows.length, 2); // old soft-deleted row plus the new one
  assert.ok(rows[0].deleted_at);
  assert.equal(rows[1].deleted_at, null);
});

// --- Shop closure cleans up its add-ons ---

test('closing a non-last shop soft-deletes its add-ons too', async () => {
  const { header, shopId } = await setupShop('chain');
  // Second shop so the first is not the last one (subscription survives).
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });
  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  await request(app).delete(`/api/shops/${shopId}`).set('Authorization', header);

  const rows = await addonRows(shopId);
  assert.ok(rows[0].deleted_at);
});

test('closing the last shop soft-deletes its add-ons too', async () => {
  const { header, shopId } = await setupShop('single');
  await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  await request(app).delete(`/api/shops/${shopId}`).set('Authorization', header);

  const rows = await addonRows(shopId);
  assert.ok(rows[0].deleted_at);
});
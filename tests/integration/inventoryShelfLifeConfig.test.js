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
    [uniqueEmail('shelf-life-owner'), passwordHash]
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
      name: `Shelf Life Test Ltd ${crypto.randomUUID()}`,
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
  return { header, shopId: shopRes.body.id };
}

// --- Setting on create ---

test('POST creates an item with both shelf-life durations', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({
      name: 'Milk',
      unit: 'L',
      quantityOnHand: 10,
      shelfLifeDays: 14,
      shelfLifeOpenedDays: 3,
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.shelfLifeDays, 14);
  assert.equal(res.body.shelfLifeOpenedDays, 3);
});

test('an item created with neither shelf-life field has both as null', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Canned Beans', unit: 'each' });

  assert.equal(res.status, 201);
  assert.equal(res.body.shelfLifeDays, null);
  assert.equal(res.body.shelfLifeOpenedDays, null);
});

test('shelfLifeDays and shelfLifeOpenedDays can be set independently', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Flour', unit: 'kg', shelfLifeDays: 180 });

  assert.equal(res.status, 201);
  assert.equal(res.body.shelfLifeDays, 180);
  assert.equal(res.body.shelfLifeOpenedDays, null);
});

// --- Updating / clearing ---

test('PATCH sets shelf-life durations on an existing item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', quantityOnHand: 10 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ shelfLifeDays: 14, shelfLifeOpenedDays: 3 });

  assert.equal(res.status, 200);
  assert.equal(res.body.shelfLifeDays, 14);
  assert.equal(res.body.shelfLifeOpenedDays, 3);
});

test('PATCH with explicit null clears a shelf-life field, distinct from omitting it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', shelfLifeDays: 14, shelfLifeOpenedDays: 3 });

  // Omitting both fields leaves them untouched.
  const untouchedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ name: 'Milk (renamed)' });
  assert.equal(untouchedRes.body.shelfLifeDays, 14);
  assert.equal(untouchedRes.body.shelfLifeOpenedDays, 3);

  // Explicit null clears only the targeted field.
  const clearedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ shelfLifeOpenedDays: null });
  assert.equal(clearedRes.status, 200);
  assert.equal(clearedRes.body.shelfLifeDays, 14);
  assert.equal(clearedRes.body.shelfLifeOpenedDays, null);
});

// --- Validation ---

test('shelfLifeDays of 0 is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', shelfLifeDays: 0 });

  assert.equal(res.status, 400);
});

test('a negative shelfLifeOpenedDays is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', shelfLifeOpenedDays: -1 });

  assert.equal(res.status, 400);
});

test('a non-integer shelf-life value is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', shelfLifeDays: 2.5 });

  assert.equal(res.status, 400);
});

// --- Cross-shop overview (7.8) surfaces shelf life too ---

test('the cross-shop overview includes shelf-life fields', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', shelfLifeDays: 14, shelfLifeOpenedDays: 3 });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body[0].shelfLifeDays, 14);
  assert.equal(res.body[0].shelfLifeOpenedDays, 3);
});

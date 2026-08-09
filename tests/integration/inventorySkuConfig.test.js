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
    [uniqueEmail('sku-config-owner'), passwordHash]
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
      name: `SKU Config Test Ltd ${crypto.randomUUID()}`,
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

async function createSecondShop(header) {
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Second Shop',
      addressLine1: '3 Market St',
      city: 'London',
      postcode: 'E1 2AA',
      country: 'UK',
      phone: '02011113333',
      vatRegistered: true,
    });
  return res.body.id;
}

// --- Setting on create ---

test('POST creates an item with a sku', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: '5012345678900' });

  assert.equal(res.status, 201);
  assert.equal(res.body.sku, '5012345678900');
});

test('an item created with no sku has it as null', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Loose Item', unit: 'each' });

  assert.equal(res.status, 201);
  assert.equal(res.body.sku, null);
});

// --- Uniqueness ---

test('two items in the same shop cannot share a sku', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: 'DUPLICATE-SKU' });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can (mislabelled)', unit: 'each', sku: 'DUPLICATE-SKU' });

  assert.equal(res.status, 409);
});

test('multiple items in the same shop can each have no sku', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const first = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Item A', unit: 'each' });
  const second = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Item B', unit: 'each' });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
});

test('the same sku can be used in two different shops', async () => {
  const { header, shopId: shopAId } = await setupOwnerWithShop();
  const shopBId = await createSecondShop(header);

  const resA = await request(app)
    .post(`/api/shops/${shopAId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: 'SAME-SKU' });
  const resB = await request(app)
    .post(`/api/shops/${shopBId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: 'SAME-SKU' });

  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201);
});

// --- Updating / clearing ---

test('PATCH sets a sku on an existing item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each' });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ sku: '5012345678900' });

  assert.equal(res.status, 200);
  assert.equal(res.body.sku, '5012345678900');
});

test('PATCH with explicit null clears the sku, distinct from omitting it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: '5012345678900' });

  const untouchedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ name: 'Cola Can (renamed)' });
  assert.equal(untouchedRes.body.sku, '5012345678900');

  const clearedRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ sku: null });
  assert.equal(clearedRes.status, 200);
  assert.equal(clearedRes.body.sku, null);
});

test('PATCHing a sku that collides with another item in the same shop is a 409', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Item A', unit: 'each', sku: 'TAKEN-SKU' });
  const itemB = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Item B', unit: 'each' });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${itemB.body.id}`)
    .set('Authorization', header)
    .send({ sku: 'TAKEN-SKU' });

  assert.equal(res.status, 409);
});

// --- Overview (7.8) surfaces sku too ---

test('the cross-shop overview includes sku', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'Cola Can', unit: 'each', sku: '5012345678900' });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body[0].sku, '5012345678900');
});

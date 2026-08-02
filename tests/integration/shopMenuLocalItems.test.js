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
    [uniqueEmail('localitem-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Local Item Test Ltd',
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

async function createCategory(header) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  return res.body;
}

// --- Create ---

test('POST local items creates a shop-exclusive item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Chicken Falafel Wrap', description: 'Local special', price: 6.5 });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Chicken Falafel Wrap');
  assert.equal(res.body.price, 6.5);
  assert.equal(res.body.shopId, shopId);
});

test('POST local items with a nonexistent categoryId returns 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: crypto.randomUUID(), name: 'Wrap', price: 6.5 });

  assert.equal(res.status, 404);
});

test('POST local items with a category from another company returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const categoryA = await createCategory(ownerA.header);
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${ownerB.shopId}/menu/items`)
    .set('Authorization', ownerB.header)
    .send({ categoryId: categoryA.id, name: 'Wrap', price: 6.5 });

  assert.equal(res.status, 404);
});

test('POST local items rejects a zero or negative price', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Free Wrap', price: 0 });

  assert.equal(res.status, 400);
});

// --- List / Get ---

test('GET local items lists only this shop\'s local items', async () => {
  const ownerA = await setupOwnerWithShop();
  const categoryA = await createCategory(ownerA.header);
  await request(app)
    .post(`/api/shops/${ownerA.shopId}/menu/items`)
    .set('Authorization', ownerA.header)
    .send({ categoryId: categoryA.id, name: 'Wrap A', price: 6.5 });

  const shopBRes = await request(app)
    .post('/api/shops')
    .set('Authorization', ownerA.header)
    .send({
      name: 'Second Shop',
      addressLine1: '3 Other St',
      city: 'London',
      postcode: 'E2 2AA',
      country: 'UK',
      phone: '02033334444',
      vatRegistered: true,
    });
  const shopB = shopBRes.body.id;
  await request(app)
    .post(`/api/shops/${shopB}/menu/items`)
    .set('Authorization', ownerA.header)
    .send({ categoryId: categoryA.id, name: 'Wrap B', price: 7.5 });

  const res = await request(app)
    .get(`/api/shops/${ownerA.shopId}/menu/items`)
    .set('Authorization', ownerA.header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Wrap A');
});

test('a local item from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const categoryA = await createCategory(ownerA.header);
  const item = await request(app)
    .post(`/api/shops/${ownerA.shopId}/menu/items`)
    .set('Authorization', ownerA.header)
    .send({ categoryId: categoryA.id, name: 'Wrap A', price: 6.5 });
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/menu/items/${item.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

// --- Update / Delete ---

test('PATCH local items updates price and description', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Wrap', price: 6.5 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/items/${item.body.id}`)
    .set('Authorization', header)
    .send({ price: 7.0, description: 'Now with extra sauce' });

  assert.equal(res.status, 200);
  assert.equal(res.body.price, 7.0);
  assert.equal(res.body.description, 'Now with extra sauce');
});

test('DELETE local items removes the item; it disappears from listings', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await createCategory(header);
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Wrap', price: 6.5 });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/menu/items/${item.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/menu/items/${item.body.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 404);
});
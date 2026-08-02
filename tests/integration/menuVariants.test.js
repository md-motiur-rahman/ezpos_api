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
    [uniqueEmail('variant-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithCompany() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Variant Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  return { userId, header };
}

async function createCategoryAndItem(header) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Nuggets', price: 4.99 });
  return item.body;
}

// --- Create ---

test('POST variants creates a variant under an item', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Large');
  assert.equal(res.body.price, 6.99);
  assert.equal(res.body.menuItemId, item.id);
});

test('POST variants rejects a zero or negative price', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Free', price: 0 });

  assert.equal(res.status, 400);
});

test('POST variants on an item from another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const itemA = await createCategoryAndItem(ownerA.header);
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${itemA.id}/variants`)
    .set('Authorization', ownerB.header)
    .send({ name: 'Large', price: 6.99 });

  assert.equal(res.status, 404);
});

// --- List ---

test('GET variants lists all variants for an item', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Small', price: 3.99 });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });

  const res = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

// --- Update / Delete ---

test('PATCH variants updates price and name', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const variant = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${item.id}/variants/${variant.body.id}`)
    .set('Authorization', header)
    .send({ price: 7.49, name: 'Extra Large' });

  assert.equal(res.status, 200);
  assert.equal(res.body.price, 7.49);
  assert.equal(res.body.name, 'Extra Large');
});

test('a variant from another item returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const itemA = await createCategoryAndItem(header);
  const itemB = await createCategoryAndItem(header);
  const variant = await request(app)
    .post(`/api/companies/mine/menu-items/${itemA.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${itemB.id}/variants/${variant.body.id}`)
    .set('Authorization', header)
    .send({ price: 8.0 });

  assert.equal(res.status, 404);
});

test('DELETE variants removes it; the base item and its price are unaffected', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const variant = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });

  const deleteRes = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/variants/${variant.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/variants`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);

  const itemRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}`)
    .set('Authorization', header);
  assert.equal(itemRes.status, 200);
  assert.equal(itemRes.body.price, 4.99); // base item untouched
});
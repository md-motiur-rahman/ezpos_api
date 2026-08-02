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
    [uniqueEmail('menu-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Menu Test Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

async function setupOwnerWithCompany() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  return { userId, header };
}

async function createCategory(header, overrides = {}) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Starters', ...overrides });
  return res.body;
}

// --- Auth guard ---

test('menu endpoints reject requests with no auth token', async () => {
  const res = await request(app).get('/api/companies/mine/menu-categories');
  assert.equal(res.status, 401);
});

// --- Category CRUD ---

test('POST menu-categories creates a category, active by default', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Starters' });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Starters');
  assert.equal(res.body.isActive, true);
});

test('POST menu-categories rejects a missing name', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 400);
});

test('GET menu-categories lists categories for the owner\'s company', async () => {
  const { header } = await setupOwnerWithCompany();
  await createCategory(header, { name: 'Starters' });
  await createCategory(header, { name: 'Mains' });

  const res = await request(app)
    .get('/api/companies/mine/menu-categories')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('PATCH menu-categories updates name and displayOrder', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);

  const res = await request(app)
    .patch(`/api/companies/mine/menu-categories/${category.id}`)
    .set('Authorization', header)
    .send({ name: 'Appetizers', displayOrder: 5 });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Appetizers');
  assert.equal(res.body.displayOrder, 5);
});

test('a category from another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const categoryA = await createCategory(ownerA.header);
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .patch(`/api/companies/mine/menu-categories/${categoryA.id}`)
    .set('Authorization', ownerB.header)
    .send({ name: 'Hijacked' });

  assert.equal(res.status, 404);
});

// --- The clarified delete/toggle behavior ---

test('a category with items cannot be deleted - 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', price: 5.5 });

  const res = await request(app)
    .delete(`/api/companies/mine/menu-categories/${category.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

test('a category with items CAN be toggled inactive instead of deleted', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', price: 5.5 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-categories/${category.id}`)
    .set('Authorization', header)
    .send({ isActive: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.isActive, false);
});

test('a category can be deleted once all its items are deleted', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', price: 5.5 });

  await request(app)
    .delete(`/api/companies/mine/menu-items/${item.body.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .delete(`/api/companies/mine/menu-categories/${category.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});

test('an empty category can be deleted directly', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);

  const res = await request(app)
    .delete(`/api/companies/mine/menu-categories/${category.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});

// --- Item CRUD ---

test('POST menu-items creates an item under a category', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);

  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', description: 'Tomato soup', price: 5.5 });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Soup');
  assert.equal(res.body.price, 5.5);
  assert.equal(res.body.categoryId, category.id);
});

test('POST menu-items with a nonexistent categoryId returns 404', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: crypto.randomUUID(), name: 'Soup', price: 5.5 });

  assert.equal(res.status, 404);
});

test('POST menu-items with a category belonging to another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const categoryA = await createCategory(ownerA.header);
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', ownerB.header)
    .send({ categoryId: categoryA.id, name: 'Hijacked Item', price: 5.5 });

  assert.equal(res.status, 404);
});

test('POST menu-items rejects a zero or negative price', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);

  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Free Soup', price: 0 });

  assert.equal(res.status, 400);
});

test('GET menu-items lists all items for the company', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', price: 5.5 });
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Salad', price: 6.0 });

  const res = await request(app).get('/api/companies/mine/menu-items').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('GET menu-items filters by categoryId', async () => {
  const { header } = await setupOwnerWithCompany();
  const starters = await createCategory(header, { name: 'Starters' });
  const mains = await createCategory(header, { name: 'Mains' });
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: starters.id, name: 'Soup', price: 5.5 });
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: mains.id, name: 'Steak', price: 18.0 });

  const res = await request(app)
    .get(`/api/companies/mine/menu-items?categoryId=${starters.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Soup');
});

test('GET menu-items with a foreign categoryId filter returns 404, not an empty list', async () => {
  const ownerA = await setupOwnerWithCompany();
  const categoryA = await createCategory(ownerA.header);
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .get(`/api/companies/mine/menu-items?categoryId=${categoryA.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

test('PATCH menu-items updates price and can move an item to another category', async () => {
  const { header } = await setupOwnerWithCompany();
  const starters = await createCategory(header, { name: 'Starters' });
  const mains = await createCategory(header, { name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: starters.id, name: 'Soup', price: 5.5 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${item.body.id}`)
    .set('Authorization', header)
    .send({ price: 6.5, categoryId: mains.id });

  assert.equal(res.status, 200);
  assert.equal(res.body.price, 6.5);
  assert.equal(res.body.categoryId, mains.id);
});

test('DELETE menu-items removes the item; it disappears from listings', async () => {
  const { header } = await setupOwnerWithCompany();
  const category = await createCategory(header);
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.id, name: 'Soup', price: 5.5 });

  const deleteRes = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.body.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 404);
});

test('an item from another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const categoryA = await createCategory(ownerA.header);
  const itemA = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', ownerA.header)
    .send({ categoryId: categoryA.id, name: 'Soup', price: 5.5 });
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .get(`/api/companies/mine/menu-items/${itemA.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});
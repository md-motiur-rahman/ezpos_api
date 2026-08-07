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
    [uniqueEmail('ingredient-owner'), passwordHash]
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
      name: 'Ingredient Test Ltd',
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
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  return item.body;
}

// --- Ingredient CRUD ---

test('POST ingredients creates an ingredient with a unit and allergens', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Wheat Flour');
  assert.equal(res.body.unit, 'kg');
  assert.deepEqual(res.body.allergens, ['gluten']);
});

test('POST ingredients defaults to an empty allergens array', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Water', unit: 'L' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body.allergens, []);
});

test('POST ingredients rejects a missing unit', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Water' });

  assert.equal(res.status, 400);
});

test('POST ingredients rejects an unknown allergen code', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Mystery Ingredient', unit: 'each', allergens: ['unicorn_dust'] });

  assert.equal(res.status, 400);
});

test('GET ingredients lists ingredients for the company', async () => {
  const { header } = await setupOwnerWithCompany();
  await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });
  await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', allergens: ['milk'] });

  const res = await request(app).get('/api/companies/mine/ingredients').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('PATCH ingredients updates name, unit, and allergens', async () => {
  const { header } = await setupOwnerWithCompany();
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', allergens: ['milk'] });

  const res = await request(app)
    .patch(`/api/companies/mine/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ name: 'Oat Milk', unit: 'ml', allergens: [] });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Oat Milk');
  assert.equal(res.body.unit, 'ml');
  assert.deepEqual(res.body.allergens, []);
});

test('an ingredient from another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const ingredientA = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', ownerA.header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .patch(`/api/companies/mine/ingredients/${ingredientA.body.id}`)
    .set('Authorization', ownerB.header)
    .send({ name: 'Hijacked' });

  assert.equal(res.status, 404);
});

test('DELETE removes an ingredient; it disappears from listings', async () => {
  const { header } = await setupOwnerWithCompany();
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Milk', unit: 'L', allergens: ['milk'] });

  const deleteRes = await request(app)
    .delete(`/api/companies/mine/ingredients/${ingredient.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app).get('/api/companies/mine/ingredients').set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

// --- Attach / detach to a master item's recipe (7.2: now with quantity) ---

test('POST attaches an ingredient to an item with a quantity', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });

  assert.equal(res.status, 201);
});

test('POST attaching an ingredient with no quantity is rejected', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg' });

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 400);
});

test('attaching the same ingredient twice returns 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.2 });

  assert.equal(res.status, 409);
});

test('PATCH adjusts an already-attached ingredient\'s quantity without detaching', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg' });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.2 });

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body[0].quantity, 0.2);
});

test('PATCH quantity on an ingredient that is not attached returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg' });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.2 });

  assert.equal(res.status, 404);
});

test('GET item ingredients returns the attached ingredients with their quantities', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });

  const res = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/ingredients`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, ingredient.body.id);
  assert.equal(res.body[0].quantity, 0.15);
  assert.equal(res.body[0].unit, 'kg');
});

test('DELETE detaches an ingredient from an item', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });

  const deleteRes = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('detaching an ingredient that is not attached returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Wheat Flour', unit: 'kg', allergens: ['gluten'] });

  const res = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/ingredients/${ingredient.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});
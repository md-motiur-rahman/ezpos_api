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
    [uniqueEmail('allergen-owner'), passwordHash]
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
      name: 'Allergen Test Ltd',
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

async function createIngredient(header, name, unit, allergens) {
  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name, unit, allergens });
  return res.body;
}

// --- Resolved GET /menu: allergen aggregation on master items ---

test('GET /menu unions allergens from two ingredients with an overlapping allergen, deduplicated', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  const flour = await createIngredient(header, 'Wheat Flour', 'kg', ['gluten']);
  const milk = await createIngredient(header, 'Milk', 'L', ['milk', 'gluten']);
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.body.id}/ingredients/${flour.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.15 });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.body.id}/ingredients/${milk.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.05 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.body.id);
  assert.deepEqual(resolvedItem.allergens, ['gluten', 'milk']); // deduplicated and sorted
});

test('an item with no ingredients gets an empty allergens array, not undefined', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Sides' });
  await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Fries', price: 2.5 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  assert.deepEqual(res.body[0].allergens, []);
});

test('an item whose only ingredient has no allergens gets an empty allergens array', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Sides' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Fries', price: 2.5 });
  const water = await createIngredient(header, 'Water', 'L', []);
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.body.id}/ingredients/${water.id}`)
    .set('Authorization', header)
    .send({ quantity: 0.1 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.body.id);
  assert.deepEqual(resolvedItem.allergens, []);
});

// --- Attach / detach to a LOCAL item's recipe, and resolved allergens on local items ---

test('POST attaches an ingredient to a local item with a quantity', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce', 'ml', ['soybeans']);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 20 });

  assert.equal(res.status, 201);
});

test('attaching a foreign-company ingredient to a local item returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', ownerA.header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${ownerA.shopId}/menu/items`)
    .set('Authorization', ownerA.header)
    .send({ categoryId: category.body.id, name: 'Wrap', price: 5.99 });
  const ownerB = await setupOwnerWithShop();
  const ingredientB = await createIngredient(ownerB.header, 'Sauce', 'ml', []);

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/menu/items/${item.body.id}/ingredients/${ingredientB.id}`)
    .set('Authorization', ownerA.header)
    .send({ quantity: 20 });

  assert.equal(res.status, 404);
});

test('GET /menu aggregates allergens on the West London wrap (local item) case', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  const soy = await createIngredient(header, 'Sweet Chilli Sauce', 'ml', ['soybeans']);
  const sesame = await createIngredient(header, 'Sesame Seeds', 'g', ['sesame']);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${soy.id}`)
    .set('Authorization', header)
    .send({ quantity: 20 });
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${sesame.id}`)
    .set('Authorization', header)
    .send({ quantity: 5 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.body.id);
  assert.equal(resolvedItem.source, 'local');
  assert.deepEqual(resolvedItem.allergens, ['sesame', 'soybeans']);
});

test('PATCH adjusts a local item ingredient\'s quantity without detaching', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Wrap', price: 5.99 });
  const ingredient = await createIngredient(header, 'Sauce', 'ml', []);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 20 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 30 });

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body[0].quantity, 30);
});

test('DELETE detaches an ingredient from a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Wrap', price: 5.99 });
  const ingredient = await createIngredient(header, 'Sauce', 'ml', ['soybeans']);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 20 });

  const res = await request(app)
    .delete(`/api/shops/${shopId}/menu/items/${item.body.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});
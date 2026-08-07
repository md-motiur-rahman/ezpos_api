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
    [uniqueEmail('recipe-owner'), passwordHash]
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
      name: 'Recipe Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  return { userId, header };
}

async function createItemWithVariant(header) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Nuggets', price: 4.99 });
  const variant = await request(app)
    .post(`/api/companies/mine/menu-items/${item.body.id}/variants`)
    .set('Authorization', header)
    .send({ name: 'Large', price: 6.99 });
  return { item: item.body, variant: variant.body };
}

async function createGroupWithOption(header) {
  const group = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: 'Choose your sauce', minSelections: 1, maxSelections: 1 });
  const option = await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.body.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Sweet Chilli Sauce', priceDelta: 0.3 });
  return { group: group.body, option: option.body };
}

async function createIngredient(header, name, unit) {
  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name, unit });
  return res.body;
}

// --- Variant recipes ---

test('POST attaches an ingredient to a variant with a quantity', async () => {
  const { header } = await setupOwnerWithCompany();
  const { item, variant } = await createItemWithVariant(header);
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 8 });

  assert.equal(res.status, 201);
});

test('attaching the same ingredient to a variant twice returns 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const { item, variant } = await createItemWithVariant(header);
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 8 });

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 10 });

  assert.equal(res.status, 409);
});

test('GET variant ingredients returns the recipe with quantities', async () => {
  const { header } = await setupOwnerWithCompany();
  const { item, variant } = await createItemWithVariant(header);
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 8 });

  const res = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, ingredient.id);
  assert.equal(res.body[0].quantity, 8);
});

test('PATCH adjusts a variant ingredient\'s quantity without detaching', async () => {
  const { header } = await setupOwnerWithCompany();
  const { item, variant } = await createItemWithVariant(header);
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 8 });

  const res = await request(app)
    .patch(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 10 });

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body[0].quantity, 10);
});

test('DELETE detaches an ingredient from a variant', async () => {
  const { header } = await setupOwnerWithCompany();
  const { item, variant } = await createItemWithVariant(header);
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header)
    .send({ quantity: 8 });

  const res = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients/${ingredient.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/variants/${variant.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('attaching an ingredient to a variant from another item returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const { variant } = await createItemWithVariant(header);
  const otherItem = await createItemWithVariant(header); // a second, unrelated item
  const ingredient = await createIngredient(header, 'Chicken Portion', 'each');

  const res = await request(app)
    .post(
      `/api/companies/mine/menu-items/${otherItem.item.id}/variants/${variant.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 8 });

  assert.equal(res.status, 404);
});

// --- Modifier option recipes ---

test('POST attaches an ingredient to a modifier option with a quantity', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');

  const res = await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 15 });

  assert.equal(res.status, 201);
});

test('attaching the same ingredient to a modifier option twice returns 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');
  await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 15 });

  const res = await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 20 });

  assert.equal(res.status, 409);
});

test('GET modifier option ingredients returns the recipe with quantities', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');
  await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 15 });

  const res = await request(app)
    .get(`/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].quantity, 15);
});

test('PATCH adjusts a modifier option ingredient\'s quantity without detaching', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');
  await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 15 });

  const res = await request(app)
    .patch(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 25 });

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body[0].quantity, 25);
});

test('DELETE detaches an ingredient from a modifier option', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');
  await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 15 });

  const res = await request(app)
    .delete(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header);

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('quantity must be positive when attaching to a modifier option', async () => {
  const { header } = await setupOwnerWithCompany();
  const { group, option } = await createGroupWithOption(header);
  const ingredient = await createIngredient(header, 'Sweet Chilli Sauce Base', 'ml');

  const res = await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${group.id}/options/${option.id}/ingredients/${ingredient.id}`
    )
    .set('Authorization', header)
    .send({ quantity: 0 });

  assert.equal(res.status, 400);
});
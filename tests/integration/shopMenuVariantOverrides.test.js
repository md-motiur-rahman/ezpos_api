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
    [uniqueEmail('variantoverride-owner'), passwordHash]
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
      name: 'Variant Override Test Ltd',
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

async function createItemWithVariant(header, priceOverrides = {}) {
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
    .send({ name: 'Large', price: 6.99, ...priceOverrides });
  return { item: item.body, variant: variant.body };
}

// --- Variant override upsert ---

test('setting isEnabled on a variant override creates it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { variant } = await createItemWithVariant(header);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.isEnabled, false);
  assert.equal(res.body.priceOverride, null);
});

test('setting priceOverride on a variant independently does not touch isEnabled', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { variant } = await createItemWithVariant(header);

  await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ priceOverride: 5.99 });

  assert.equal(res.status, 200);
  assert.equal(res.body.priceOverride, 5.99);
  assert.equal(res.body.isEnabled, false); // untouched
});

test('PATCH variant override on a variant from another company returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const { variant } = await createItemWithVariant(ownerA.header);
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .patch(`/api/shops/${ownerB.shopId}/menu/variants/${variant.id}`)
    .set('Authorization', ownerB.header)
    .send({ isEnabled: false });

  assert.equal(res.status, 404);
});

test('DELETE variant override reverts to master defaults', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { variant } = await createItemWithVariant(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false, priceOverride: 5.99 });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const menuRes = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);
  const resolvedVariant = menuRes.body[0].variants.find((v) => v.id === variant.id);
  assert.equal(resolvedVariant.isEnabled, true);
  assert.equal(resolvedVariant.price, 6.99);
});

// --- Resolved GET /menu: variants array ---

test('GET /menu nests resolved variants under their parent item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, variant } = await createItemWithVariant(header);

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.variants.length, 1);
  assert.equal(resolvedItem.variants[0].id, variant.id);
  assert.equal(resolvedItem.variants[0].price, 6.99);
  assert.equal(resolvedItem.variants[0].masterPrice, 6.99);
});

test('GET /menu applies a variant price override', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, variant } = await createItemWithVariant(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ priceOverride: 5.99 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.variants[0].price, 5.99);
  assert.equal(resolvedItem.variants[0].masterPrice, 6.99);
});

test('GET /menu shows a disabled variant as disabled, not hidden', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, variant } = await createItemWithVariant(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variant.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.variants.length, 1); // still present
  assert.equal(resolvedItem.variants[0].isEnabled, false);
});

test('an item with no variants gets an empty variants array, not undefined', async () => {
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

  assert.deepEqual(res.body[0].variants, []);
});
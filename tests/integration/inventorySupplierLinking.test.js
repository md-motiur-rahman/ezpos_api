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
    [uniqueEmail('linking-owner'), passwordHash]
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
      name: 'Linking Test Ltd',
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

async function createItem(header, shopId, name = 'Chicken Breast') {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name, unit: 'kg' });
  return res.body;
}

async function createSupplier(header, shopId, name = 'Bidfood') {
  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name });
  return res.body;
}

// --- Attach / detach / list ---

test('POST links a supplier to an item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const supplier = await createSupplier(header, shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 201);
});

test('linking the same supplier to an item twice returns 409', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const supplier = await createSupplier(header, shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header)
    .send({});

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 409);
});

test('GET item suppliers returns the linked suppliers', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  const brakes = await createSupplier(header, shopId, 'Brakes');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({});
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({});

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('DELETE unlinks a supplier from an item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const supplier = await createSupplier(header, shopId);
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header)
    .send({});

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('unlinking a supplier that is not linked returns 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const supplier = await createSupplier(header, shopId);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${supplier.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

test('linking a supplier from another shop to an item returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const item = await createItem(ownerA.header, ownerA.shopId);
  const ownerB = await setupOwnerWithShop();
  const supplierB = await createSupplier(ownerB.header, ownerB.shopId);

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/inventory-items/${item.id}/suppliers/${supplierB.id}`)
    .set('Authorization', ownerA.header)
    .send({});

  assert.equal(res.status, 404);
});
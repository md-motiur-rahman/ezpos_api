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
    [uniqueEmail('default-owner'), passwordHash]
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
      name: 'Default Supplier Test Ltd',
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

async function createSupplier(header, shopId, name) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name });
  return res.body;
}

function findSupplier(list, id) {
  return list.find((s) => s.id === id);
}

// --- The core scenario: "chicken breast defaults to Bidfood but can also come from another vendor" ---

test('POST can attach a supplier as the default directly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });

  assert.equal(res.status, 201);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  assert.equal(findSupplier(listRes.body, bidfood.id).isDefault, true);
});

test('a supplier attached with no isDefault specified defaults to false', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({});

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  assert.equal(findSupplier(listRes.body, bidfood.id).isDefault, false);
});

test('PATCH switches the default from one supplier to another - the field is editable', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  const brakes = await createSupplier(header, shopId, 'Brakes');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({});

  // Switch the default to Brakes, exactly the confirmed scenario.
  const patchRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });
  assert.equal(patchRes.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  assert.equal(findSupplier(listRes.body, brakes.id).isDefault, true);
  // The critical assertion: Bidfood was automatically un-defaulted -
  // exactly the swap logic that was empirically caught and fixed.
  assert.equal(findSupplier(listRes.body, bidfood.id).isDefault, false);
});

test('at most one supplier is ever the default for an item, even across multiple switches', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  const brakes = await createSupplier(header, shopId, 'Brakes');
  const freshDirect = await createSupplier(header, shopId, 'Fresh Direct');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({});
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${freshDirect.id}`)
    .set('Authorization', header)
    .send({});

  await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });
  await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${freshDirect.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  const defaultCount = listRes.body.filter((s) => s.isDefault).length;
  assert.equal(defaultCount, 1);
  assert.equal(findSupplier(listRes.body, freshDirect.id).isDefault, true);
});

test('PATCH with isDefault: false clears the default, leaving the item with none', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });

  const patchRes = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: false });
  assert.equal(patchRes.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers`)
    .set('Authorization', header);
  assert.equal(findSupplier(listRes.body, bidfood.id).isDefault, false);
});

test('PATCH isDefault on a supplier not linked to the item returns 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId);
  const bidfood = await createSupplier(header, shopId, 'Bidfood');

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${item.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });

  assert.equal(res.status, 404);
});

test('two different items can each have their own independent default supplier', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast');
  const beef = await createItem(header, shopId, 'Beef Mince');
  const bidfood = await createSupplier(header, shopId, 'Bidfood');
  const brakes = await createSupplier(header, shopId, 'Brakes');
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${chicken.id}/suppliers/${bidfood.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${beef.id}/suppliers/${brakes.id}`)
    .set('Authorization', header)
    .send({ isDefault: true });

  const chickenSuppliers = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${chicken.id}/suppliers`)
    .set('Authorization', header);
  const beefSuppliers = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${beef.id}/suppliers`)
    .set('Authorization', header);

  assert.equal(findSupplier(chickenSuppliers.body, bidfood.id).isDefault, true);
  assert.equal(findSupplier(beefSuppliers.body, brakes.id).isDefault, true);
});
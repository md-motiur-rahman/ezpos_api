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
    [uniqueEmail('modifieroverride-owner'), passwordHash]
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
      name: 'Modifier Override Test Ltd',
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

/** Item with an attached "Choose your sauce" group having one option, per the confirmed example. */
async function createItemWithModifier(header) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  const group = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: 'Choose your sauce', minSelections: 1, maxSelections: 1 });
  const option = await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.body.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Sweet Chilli Sauce', priceDelta: 0.3 });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.body.id}/modifier-groups/${group.body.id}`)
    .set('Authorization', header);
  return { item: item.body, group: group.body, option: option.body };
}

// --- Option override upsert ---

test('setting isEnabled on a modifier option override creates it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { option } = await createItemWithModifier(header);

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  assert.equal(res.status, 200);
  assert.equal(res.body.isEnabled, false);
  assert.equal(res.body.priceDeltaOverride, null);
});

test('setting priceDeltaOverride independently does not touch isEnabled, and can be negative', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { option } = await createItemWithModifier(header);

  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ priceDeltaOverride: -0.2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.priceDeltaOverride, -0.2);
  assert.equal(res.body.isEnabled, false); // untouched
});

test('PATCH override on an option from another company returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const { option } = await createItemWithModifier(ownerA.header);
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .patch(`/api/shops/${ownerB.shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', ownerB.header)
    .send({ isEnabled: false });

  assert.equal(res.status, 404);
});

test('DELETE override reverts to master defaults', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { option } = await createItemWithModifier(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false, priceDeltaOverride: -0.2 });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const menuRes = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);
  const resolvedOption = menuRes.body[0].modifierGroups[0].options[0];
  assert.equal(resolvedOption.isEnabled, true);
  assert.equal(resolvedOption.price, 0.3);
});

// --- Resolved GET /menu: modifierGroups nesting on master items ---

test('GET /menu nests the resolved modifier group and its option under the master item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, group, option } = await createItemWithModifier(header);

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.modifierGroups.length, 1);
  assert.equal(resolvedItem.modifierGroups[0].id, group.id);
  assert.equal(resolvedItem.modifierGroups[0].minSelections, 1);
  assert.equal(resolvedItem.modifierGroups[0].maxSelections, 1);
  assert.equal(resolvedItem.modifierGroups[0].options.length, 1);
  assert.equal(resolvedItem.modifierGroups[0].options[0].id, option.id);
  assert.equal(resolvedItem.modifierGroups[0].options[0].price, 0.3);
  assert.equal(resolvedItem.modifierGroups[0].options[0].masterPriceDelta, 0.3);
});

test('GET /menu applies a modifier option price override', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, option } = await createItemWithModifier(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ priceDeltaOverride: -0.1 });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.modifierGroups[0].options[0].price, -0.1);
  assert.equal(resolvedItem.modifierGroups[0].options[0].masterPriceDelta, 0.3);
});

test('GET /menu shows a disabled option as disabled, not hidden', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, option } = await createItemWithModifier(header);
  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.modifierGroups[0].options.length, 1); // still present
  assert.equal(resolvedItem.modifierGroups[0].options[0].isEnabled, false);
});

test('an item with no modifier groups attached gets an empty modifierGroups array', async () => {
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

  assert.deepEqual(res.body[0].modifierGroups, []);
});
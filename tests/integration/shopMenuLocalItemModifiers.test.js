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
    [uniqueEmail('localmodifier-owner'), passwordHash]
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
      name: 'Local Modifier Test Ltd',
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
      name: 'West London Shop',
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: true,
    });
  return { header, shopId: shopRes.body.id };
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

/** The West London chicken wrap - a shop-exclusive local item, per the confirmed example. */
async function createLocalItem(header, shopId) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  return item.body;
}

// --- Attach / detach to a LOCAL item ---

test('POST attaches a modifier group to a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createLocalItem(header, shopId);
  const { group } = await createGroupWithOption(header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 201);
});

test('attaching the same group to a local item twice returns 409', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createLocalItem(header, shopId);
  const { group } = await createGroupWithOption(header);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

test('attaching a group from another company to a local item returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const item = await createLocalItem(ownerA.header, ownerA.shopId);
  const ownerB = await setupOwnerWithShop();
  const { group } = await createGroupWithOption(ownerB.header);

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', ownerA.header);

  assert.equal(res.status, 404);
});

test('DELETE detaches a modifier group from a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createLocalItem(header, shopId);
  const { group } = await createGroupWithOption(header);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});

// --- Resolved GET /menu: modifierGroups nesting on LOCAL items ---

test('GET /menu nests the resolved modifier group under a local item (the West London wrap case)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createLocalItem(header, shopId);
  const { group, option } = await createGroupWithOption(header);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.source, 'local');
  assert.equal(resolvedItem.modifierGroups.length, 1);
  assert.equal(resolvedItem.modifierGroups[0].id, group.id);
  assert.equal(resolvedItem.modifierGroups[0].options[0].id, option.id);
  assert.equal(resolvedItem.modifierGroups[0].options[0].price, 0.3);
});

test('a modifier option override on a local item\'s modifier applies correctly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createLocalItem(header, shopId);
  const { group, option } = await createGroupWithOption(header);
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${option.id}`)
    .set('Authorization', header)
    .send({ isEnabled: false });

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const resolvedItem = res.body.find((entry) => entry.id === item.id);
  assert.equal(resolvedItem.modifierGroups[0].options[0].isEnabled, false);
});

test('a local item with no modifier groups attached gets an empty modifierGroups array', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createLocalItem(header, shopId);

  const res = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', header);

  const localEntry = res.body.find((entry) => entry.source === 'local');
  assert.deepEqual(localEntry.modifierGroups, []);
});
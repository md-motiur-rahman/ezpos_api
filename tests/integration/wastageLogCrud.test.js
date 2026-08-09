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
    [uniqueEmail('wastage-owner'), passwordHash]
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
      name: 'Wastage Test Ltd',
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

async function createItem(header, shopId, name, initialQuantity) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name, unit: 'kg', quantityOnHand: initialQuantity });
  return res.body;
}

async function getItem(header, shopId, itemId) {
  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}`)
    .set('Authorization', header);
  return res.body;
}

// --- Core: logging wastage decrements stock ---

test('POST logs wastage and decrements quantityOnHand', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({
      items: [{ inventoryItemId: chicken.id, quantityWasted: 3, reason: 'spoiled', notes: 'fridge broke overnight' }],
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].reason, 'spoiled');
  assert.equal(res.body.items[0].notes, 'fridge broke overnight');
  assert.equal(res.body.items[0].quantityWasted, 3);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 7); // 10 - 3
});

test('reason is required and must be one of the fixed categories', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);

  const missingReason = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 1 }] });
  assert.equal(missingReason.status, 400);

  const invalidReason = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 1, reason: 'aliens' }] });
  assert.equal(invalidReason.status, 400);
});

test('notes are optional', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 1, reason: 'damaged' }] });

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].notes, null);
});

// --- Blocked: cannot waste more than is on hand ---

test('wasting more than the current quantityOnHand is blocked with a 409', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 3);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 5, reason: 'spoiled' }] });

  assert.equal(res.status, 409);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 3); // unchanged - nothing was written
});

test('wasting exactly the current quantityOnHand is allowed (brings stock to zero)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 3);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 3, reason: 'spoiled' }] });

  assert.equal(res.status, 201);
  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 0);
});

test('a multi-item wastage log where one line exceeds stock is blocked entirely - nothing is written for either line', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);
  const flour = await createItem(header, shopId, 'Flour', 2);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({
      items: [
        { inventoryItemId: chicken.id, quantityWasted: 5, reason: 'spoiled' }, // valid
        { inventoryItemId: flour.id, quantityWasted: 10, reason: 'spoiled' }, // exceeds stock
      ],
    });

  assert.equal(res.status, 409);

  const chickenAfter = await getItem(header, shopId, chicken.id);
  const flourAfter = await getItem(header, shopId, flour.id);
  assert.equal(chickenAfter.quantityOnHand, 10); // untouched, even though its own line was valid
  assert.equal(flourAfter.quantityOnHand, 2);
});

// --- Multi-item, independent decrements ---

test('a wastage log covering two items decrements both independently', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);
  const flour = await createItem(header, shopId, 'Flour', 20);

  await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({
      items: [
        { inventoryItemId: chicken.id, quantityWasted: 4, reason: 'spoiled' },
        { inventoryItemId: flour.id, quantityWasted: 6, reason: 'damaged' },
      ],
    });

  const chickenAfter = await getItem(header, shopId, chicken.id);
  const flourAfter = await getItem(header, shopId, flour.id);
  assert.equal(chickenAfter.quantityOnHand, 6);
  assert.equal(flourAfter.quantityOnHand, 14);
});

// --- Validation ---

test('a wastage log with a duplicate inventoryItemId is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({
      items: [
        { inventoryItemId: chicken.id, quantityWasted: 1, reason: 'spoiled' },
        { inventoryItemId: chicken.id, quantityWasted: 2, reason: 'damaged' },
      ],
    });

  assert.equal(res.status, 400);
});

test('a wastage log with no line items is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [] });

  assert.equal(res.status, 400);
});

test('a wastage log referencing an item from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const ownerB = await setupOwnerWithShop();
  const itemB = await createItem(ownerB.header, ownerB.shopId, 'Chicken Breast', 10);

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/wastage-logs`)
    .set('Authorization', ownerA.header)
    .send({ items: [{ inventoryItemId: itemB.id, quantityWasted: 1, reason: 'spoiled' }] });

  assert.equal(res.status, 404);
});

// --- List / Get ---

test('GET lists wastage logs for the shop', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);
  await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 2, reason: 'spoiled' }] });

  const res = await request(app).get(`/api/shops/${shopId}/wastage-logs`).set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].itemCount, 1);
});

test('GET a single wastage log returns full line item detail', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 2, reason: 'expired' }] });

  const res = await request(app)
    .get(`/api/shops/${shopId}/wastage-logs/${createRes.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].itemName, 'Chicken Breast');
  assert.equal(res.body.items[0].reason, 'expired');
});

test('a wastage log from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const itemA = await createItem(ownerA.header, ownerA.shopId, 'Chicken Breast', 10);
  const logRes = await request(app)
    .post(`/api/shops/${ownerA.shopId}/wastage-logs`)
    .set('Authorization', ownerA.header)
    .send({ items: [{ inventoryItemId: itemA.id, quantityWasted: 2, reason: 'spoiled' }] });
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/wastage-logs/${logRes.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

// --- Immutability ---

test('wastage logs have no PATCH or DELETE endpoint - immutable once created', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId, 'Chicken Breast', 10);
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items: [{ inventoryItemId: chicken.id, quantityWasted: 2, reason: 'spoiled' }] });

  const patchRes = await request(app)
    .patch(`/api/shops/${shopId}/wastage-logs/${createRes.body.id}`)
    .set('Authorization', header)
    .send({ notes: 'trying to edit' });
  assert.equal(patchRes.status, 404);

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/wastage-logs/${createRes.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 404);
});
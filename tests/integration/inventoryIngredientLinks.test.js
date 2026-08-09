import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('ingredient-links-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `Ingredient Links Test Ltd ${crypto.randomUUID()}`,
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
  return { userId, header, shopId: shopRes.body.id };
}

async function createIngredient(header, name, unit) {
  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name, unit });
  return res.body.id;
}

async function createInventoryItem(header, shopId, data) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
  return res.body.id;
}

async function insertStaff(shopId, role) {
  const pinHash = await bcrypt.hash(KNOWN_PIN, 4); // low cost - tests only
  const staffIdCode = String(crypto.randomInt(10_000_000, 99_999_999));
  const { rows } = await query(
    `INSERT INTO staff (shop_id, full_name, role, staff_id_code, pin_hash)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [shopId, `Test ${role}`, role, staffIdCode, pinHash]
  );
  return { id: rows[0].id, staffIdCode };
}

async function staffHeaderFor(shopId, staffIdCode) {
  const res = await request(app)
    .post('/api/staff-auth/login')
    .send({ shopId, staffIdCode, pin: KNOWN_PIN });
  return `Bearer ${res.body.sessionToken}`;
}

// --- Linking ---

test('an owner can link an ingredient to an inventory item with a conversion factor', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0.001 });

  assert.equal(res.status, 201);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links`)
    .set('Authorization', header);

  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].ingredientId, ingredientId);
  assert.equal(listRes.body[0].conversionFactor, 0.001);
  // The INGREDIENT's unit, not the stock item's - the whole point of the factor
  assert.equal(listRes.body[0].unit, 'g');
});

test('conversionFactor defaults to 1 when omitted', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Tomato', 'each');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Tomatoes',
    unit: 'each',
    quantityOnHand: 100,
  });

  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({});

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links`)
    .set('Authorization', header);

  assert.equal(listRes.body[0].conversionFactor, 1);
});

test('a zero or negative conversionFactor is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Salt', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Salt Stock',
    unit: 'kg',
    quantityOnHand: 10,
  });

  const zeroRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0 });
  assert.equal(zeroRes.status, 400);

  const negRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: -1 });
  assert.equal(negRes.status, 400);
});

test('linking the same ingredient twice in one shop is rejected, even to a different item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemAId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack A',
    unit: 'kg',
    quantityOnHand: 50,
  });
  const itemBId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack B',
    unit: 'kg',
    quantityOnHand: 50,
  });

  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemAId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({});

  // A DIFFERENT inventory item - the constraint is (shop, ingredient), so
  // this must still 409: the engine needs exactly one answer per ingredient.
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemBId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 409);
});

test('the same ingredient can be linked in two different shops independently', async () => {
  const { header, shopId: shopAId } = await setupOwnerWithShop();
  const shopBRes = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Second Shop',
      addressLine1: '3 Market St',
      city: 'London',
      postcode: 'E1 2AA',
      country: 'UK',
      phone: '02011113333',
      vatRegistered: true,
    });
  const shopBId = shopBRes.body.id;

  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemAId = await createInventoryItem(header, shopAId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });
  const itemBId = await createInventoryItem(header, shopBId, {
    name: 'Flour Bag',
    unit: 'g',
    quantityOnHand: 5000,
  });

  const resA = await request(app)
    .post(`/api/shops/${shopAId}/inventory-items/${itemAId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0.001 });
  const resB = await request(app)
    .post(`/api/shops/${shopBId}/inventory-items/${itemBId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 1 });

  assert.equal(resA.status, 201);
  assert.equal(resB.status, 201);
});

// --- Updating / unlinking ---

test('the conversion factor can be changed via PATCH', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0.001 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0.002 });

  assert.equal(res.status, 200);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links`)
    .set('Authorization', header);
  assert.equal(listRes.body[0].conversionFactor, 0.002);
});

test('PATCHing a link that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor: 0.002 });

  assert.equal(res.status, 404);
});

test('an ingredient can be unlinked, and unlinking twice is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({});

  const firstRes = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header);
  assert.equal(firstRes.status, 200);

  const secondRes = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header);
  assert.equal(secondRes.status, 404);
});

// --- Scoping / permissions ---

test('an ingredient from another company cannot be linked', async () => {
  const { header: headerA, shopId } = await setupOwnerWithShop();
  const itemId = await createInventoryItem(headerA, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });

  const { header: headerB } = await setupOwnerWithShop();
  const foreignIngredientId = await createIngredient(headerB, 'Someone Elses Flour', 'g');

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${foreignIngredientId}`)
    .set('Authorization', headerA)
    .send({});

  assert.equal(res.status, 404);
});

test('a Chef (VIEW_INVENTORY only) can read links but not create them', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({});

  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const readRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links`)
    .set('Authorization', chefHeader);
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.length, 1);

  const otherIngredientId = await createIngredient(header, 'Sugar', 'g');
  const writeRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${otherIngredientId}`)
    .set('Authorization', chefHeader)
    .send({});
  assert.equal(writeRes.status, 403);
});

test('a Manager (MANAGE_INVENTORY) can create links', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const ingredientId = await createIngredient(header, 'Wheat Flour', 'g');
  const itemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 50,
  });

  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', managerHeader)
    .send({ conversionFactor: 0.001 });

  assert.equal(res.status, 201);
});

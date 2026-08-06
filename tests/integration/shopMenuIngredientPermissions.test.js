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
    [uniqueEmail('ingredientperm-owner'), passwordHash]
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
      name: 'Ingredient Perm Test Ltd',
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

async function createLocalItemAndIngredient(header, shopId) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  const ingredient = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name: 'Sauce', allergens: ['soybeans'] });
  return { item: item.body, ingredient: ingredient.body };
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

test('a Manager can attach an ingredient to a local item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, ingredient } = await createLocalItemAndIngredient(header, shopId);
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/ingredients/${ingredient.id}`)
    .set('Authorization', managerHeader);

  assert.equal(res.status, 201);
});

test('a Server cannot attach an ingredient to a local item, but can still read the resolved menu', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { item, ingredient } = await createLocalItemAndIngredient(header, shopId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const attachRes = await request(app)
    .post(`/api/shops/${shopId}/menu/items/${item.id}/ingredients/${ingredient.id}`)
    .set('Authorization', serverHeader);
  assert.equal(attachRes.status, 403);

  const getRes = await request(app).get(`/api/shops/${shopId}/menu`).set('Authorization', serverHeader);
  assert.equal(getRes.status, 200);
});
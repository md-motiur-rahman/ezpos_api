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
    [uniqueEmail('inventory-overview-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function createCompany(header, { businessType } = {}) {
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `Overview Test Ltd ${crypto.randomUUID()}`,
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  if (businessType) {
    await request(app)
      .post('/api/companies/mine/business-type')
      .set('Authorization', header)
      .send({ businessType });
  }
}

async function createShop(header, name) {
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name,
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: true,
    });
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

async function addItem(header, shopId, data) {
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
}

test('a chain owner sees items from every shop, tagged with shop id and name', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'chain' });
  const shopAId = await createShop(header, 'North Branch');
  const shopBId = await createShop(header, 'South Branch');

  await addItem(header, shopAId, { name: 'Flour', unit: 'kg', quantityOnHand: 10 });
  await addItem(header, shopBId, { name: 'Sugar', unit: 'kg', quantityOnHand: 5 });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const flour = res.body.find((item) => item.name === 'Flour');
  const sugar = res.body.find((item) => item.name === 'Sugar');
  assert.equal(flour.shopId, shopAId);
  assert.equal(flour.shopName, 'North Branch');
  assert.equal(sugar.shopId, shopBId);
  assert.equal(sugar.shopName, 'South Branch');
});

test('lowStockOnly=true filters across shops', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'chain' });
  const shopAId = await createShop(header, 'North Branch');
  const shopBId = await createShop(header, 'South Branch');

  await addItem(header, shopAId, {
    name: 'Low Flour',
    unit: 'kg',
    quantityOnHand: 1,
    lowStockThreshold: 5,
  });
  await addItem(header, shopBId, {
    name: 'Well Stocked Sugar',
    unit: 'kg',
    quantityOnHand: 20,
    lowStockThreshold: 5,
  });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview?lowStockOnly=true')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Low Flour');
  assert.equal(res.body[0].isLowStock, true);
});

test('a soft-deleted item is excluded from the overview', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'chain' });
  const shopId = await createShop(header, 'North Branch');

  const createRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name: 'To Delete', unit: 'kg', quantityOnHand: 1 });
  await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${createRes.body.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
});

test('a company with no shops gets an empty array, not an error', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'chain' });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('a single-shop business (business_type: single) still works, no restriction', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'single' });
  const shopId = await createShop(header, 'Only Branch');
  await addItem(header, shopId, { name: 'Only Item', unit: 'kg', quantityOnHand: 3 });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].shopId, shopId);
});

test('a staff session token is rejected - this endpoint is owner-only', async () => {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await createCompany(header, { businessType: 'chain' });
  const shopId = await createShop(header, 'North Branch');
  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', managerHeader);

  assert.equal(res.status, 401);
});

test('an owner never sees another company\'s items', async () => {
  const userIdA = await insertUser();
  const headerA = ownerHeaderFor(userIdA);
  await createCompany(headerA, { businessType: 'chain' });
  const shopAId = await createShop(headerA, 'Company A Shop');
  await addItem(headerA, shopAId, { name: 'Company A Item', unit: 'kg', quantityOnHand: 1 });

  const userIdB = await insertUser();
  const headerB = ownerHeaderFor(userIdB);
  await createCompany(headerB, { businessType: 'chain' });
  const shopBId = await createShop(headerB, 'Company B Shop');
  await addItem(headerB, shopBId, { name: 'Company B Item', unit: 'kg', quantityOnHand: 1 });

  const res = await request(app)
    .get('/api/companies/mine/inventory-overview')
    .set('Authorization', headerA);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].name, 'Company A Item');
});

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
    [uniqueEmail('inventory-scan-owner'), passwordHash]
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
      name: `Inventory Scan Test Ltd ${crypto.randomUUID()}`,
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

function todayPlusDaysUtc(days) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtc + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function createItem(header, shopId, data) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
  return res.body;
}

// --- Core calculation ---

test('scanning a sealed item calculates expiry from shelfLifeDays', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
    shelfLifeOpenedDays: 3,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'sealed' });

  assert.equal(res.status, 201);
  assert.equal(res.body.inventoryItemId, item.id);
  assert.equal(res.body.itemName, 'Milk');
  assert.equal(res.body.unit, 'L');
  assert.equal(res.body.state, 'sealed');
  assert.equal(res.body.shelfLifeDaysUsed, 14);
  assert.equal(res.body.expiresOn, todayPlusDaysUtc(14));
});

test('scanning an opened item calculates expiry from shelfLifeOpenedDays instead', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
    shelfLifeOpenedDays: 3,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'opened' });

  assert.equal(res.status, 201);
  assert.equal(res.body.state, 'opened');
  assert.equal(res.body.shelfLifeDaysUsed, 3);
  assert.equal(res.body.expiresOn, todayPlusDaysUtc(3));
});

test('the scan response does not include stock-level fields', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    quantityOnHand: 50,
    lowStockThreshold: 5,
    shelfLifeDays: 14,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'sealed' });

  assert.equal(res.status, 201);
  assert.equal('quantityOnHand' in res.body, false);
  assert.equal('lowStockThreshold' in res.body, false);
});

// --- Failure cases ---

test('scanning an unknown sku is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'NO-SUCH-SKU', state: 'sealed' });

  assert.equal(res.status, 404);
});

test('scanning as sealed when shelfLifeDays is not configured is a 400', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, {
    name: 'Untracked Item',
    unit: 'each',
    sku: 'UNTRACKED-001',
    shelfLifeOpenedDays: 3,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'UNTRACKED-001', state: 'sealed' });

  assert.equal(res.status, 400);
});

test('scanning as opened when shelfLifeOpenedDays is not configured is a 400', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, {
    name: 'Untracked Item',
    unit: 'each',
    sku: 'UNTRACKED-002',
    shelfLifeDays: 14,
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'UNTRACKED-002', state: 'opened' });

  assert.equal(res.status, 400);
});

test('an invalid state value is rejected by validation', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'frozen' });

  assert.equal(res.status, 400);
});

// --- Listing / retrieval ---

test('a logged scan appears in the shop scan list and can be fetched by id', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'sealed' });

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].id, createRes.body.id);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/${createRes.body.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.expiresOn, createRes.body.expiresOn);
});

test('fetching a scan that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/00000000-0000-0000-0000-000000000000`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

test('a scan is scoped to its own shop - not visible from another shop', async () => {
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

  await createItem(header, shopAId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const scan = await request(app)
    .post(`/api/shops/${shopAId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'sealed' });

  const res = await request(app)
    .get(`/api/shops/${shopBId}/inventory-scans/${scan.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

// --- Permissions: broader than VIEW_INVENTORY ---

test('a Server (no VIEW_INVENTORY by default) can still scan, via PERFORM_HEALTH_SAFETY', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', serverHeader)
    .send({ sku: 'MILK-001', state: 'sealed' });

  assert.equal(res.status, 201);
});

test('a Shift Manager (no VIEW_INVENTORY by default) can list scans, via PERFORM_HEALTH_SAFETY', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku: 'MILK-001', state: 'sealed' });

  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', shiftManagerHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

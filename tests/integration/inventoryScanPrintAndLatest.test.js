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
    [uniqueEmail('scan-print-latest-owner'), passwordHash]
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
      name: `Scan Print Latest Test Ltd ${crypto.randomUUID()}`,
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

async function createItem(header, shopId, data) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
  return res.body;
}

async function createScan(header, shopId, sku, state) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans`)
    .set('Authorization', header)
    .send({ sku, state });
  return res.body;
}

// --- Print trigger ---

test('triggering a print creates a print log row with label data', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const scan = await createScan(header, shopId, 'MILK-001', 'sealed');

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scan.id}/print`)
    .set('Authorization', header);

  assert.equal(res.status, 201);
  assert.equal(res.body.scanId, scan.id);
  assert.ok(res.body.printedAt);
  assert.deepEqual(res.body.label, {
    itemName: 'Milk',
    sku: 'MILK-001',
    expiresOn: scan.expiresOn,
  });
});

test('printing the same scan twice creates two separate print records', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const scan = await createScan(header, shopId, 'MILK-001', 'sealed');

  const first = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scan.id}/print`)
    .set('Authorization', header);
  const second = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scan.id}/print`)
    .set('Authorization', header);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/${scan.id}/prints`)
    .set('Authorization', header);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 2);
  const printIds = listRes.body.map((p) => p.id).sort();
  assert.deepEqual(printIds, [first.body.id, second.body.id].sort());
});

test('printing a scan that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/00000000-0000-0000-0000-000000000000/print`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

test('a scan with no prints has an empty print list, not an error', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const scan = await createScan(header, shopId, 'MILK-001', 'sealed');

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/${scan.id}/prints`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('printing/listing prints for a scan from another shop is a 404', async () => {
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
  const scan = await createScan(header, shopAId, 'MILK-001', 'sealed');

  const printRes = await request(app)
    .post(`/api/shops/${shopBId}/inventory-scans/${scan.id}/print`)
    .set('Authorization', header);
  assert.equal(printRes.status, 404);

  const listRes = await request(app)
    .get(`/api/shops/${shopBId}/inventory-scans/${scan.id}/prints`)
    .set('Authorization', header);
  assert.equal(listRes.status, 404);
});

// --- Latest scan per item ---

test('GET /latest returns the true most recent scan for an item scanned twice', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
    shelfLifeOpenedDays: 3,
  });

  await createScan(header, shopId, 'MILK-001', 'sealed');
  const secondScan = await createScan(header, shopId, 'MILK-001', 'opened');

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/latest`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, secondScan.id);
  assert.equal(res.body[0].state, 'opened');
});

test('GET /latest returns one row per item across multiple items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  await createItem(header, shopId, { name: 'Cheese', unit: 'kg', sku: 'CHEESE-001', shelfLifeDays: 30 });

  await createScan(header, shopId, 'MILK-001', 'sealed');
  await createScan(header, shopId, 'CHEESE-001', 'sealed');

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/latest`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  const skus = res.body.map((s) => s.sku).sort();
  assert.deepEqual(skus, ['CHEESE-001', 'MILK-001']);
});

test('an item that has never been scanned does not appear in /latest', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  await createItem(header, shopId, { name: 'Never Scanned', unit: 'each', sku: 'NEVER-001' });

  await createScan(header, shopId, 'MILK-001', 'sealed');

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/latest`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].sku, 'MILK-001');
});

test('a shop with no scans at all gets an empty /latest list', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/latest`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

// --- Permissions: same PERFORM_HEALTH_SAFETY gate as 8.2 ---

test('a Chef can trigger a print and read /latest, via PERFORM_HEALTH_SAFETY', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createItem(header, shopId, { name: 'Milk', unit: 'L', sku: 'MILK-001', shelfLifeDays: 14 });
  const scan = await createScan(header, shopId, 'MILK-001', 'sealed');

  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const printRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scan.id}/print`)
    .set('Authorization', chefHeader);
  assert.equal(printRes.status, 201);

  const latestRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/latest`)
    .set('Authorization', chefHeader);
  assert.equal(latestRes.status, 200);
  assert.equal(latestRes.body.length, 1);
});

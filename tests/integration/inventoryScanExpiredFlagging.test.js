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
    [uniqueEmail('expired-flag-owner'), passwordHash]
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
      name: `Expired Flag Test Ltd ${crypto.randomUUID()}`,
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

/**
 * Test-only helper: 8.2's create-scan endpoint always computes expiresOn
 * from "today", so an ALREADY-expired scan can't be produced through the
 * real API (by design - you can't scan something into being pre-expired).
 * To test 8.4's flagging against genuinely expired data, insert the scan
 * row directly, exactly like the empirical verification query used before
 * writing the 8.4 repository code.
 */
async function insertScanDirectly(shopId, itemId, { sku, state, shelfLifeDaysUsed, expiresOn, scannedAt }) {
  const { rows } = await query(
    `INSERT INTO inventory_item_scans
       (shop_id, inventory_item_id, sku, state, shelf_life_days_used, scanned_at, expires_on)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), $7)
     RETURNING id`,
    [shopId, itemId, sku, state, shelfLifeDaysUsed, scannedAt ?? null, expiresOn]
  );
  return rows[0].id;
}

async function createWastageLog(header, shopId, items) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/wastage-logs`)
    .set('Authorization', header)
    .send({ items });
  return res.body;
}

// --- The flag list itself ---

test('an item whose latest scan has expired appears in the flag list', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, scanId);
});

test('an item not yet expired does not appear in the flag list', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2099-01-01',
  });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('a rescanned item does not appear even though an OLDER scan of it expired', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
    scannedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  // Fresh rescan, more recent, not expired - this is the TRUE current status.
  await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2099-01-01',
  });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

// --- Resolving ---

test('resolving with no wastageLogId dismisses the flag (false alarm case)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const resolveRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({ notes: 'Already used up before it expired' });

  assert.equal(resolveRes.status, 201);
  assert.equal(resolveRes.body.scanId, scanId);
  assert.equal(resolveRes.body.wastageLogId, null);
  assert.equal(resolveRes.body.notes, 'Already used up before it expired');

  const flagRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', header);
  assert.deepEqual(flagRes.body, []);
});

test('resolving with a valid wastageLogId that covers the item succeeds', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
    quantityOnHand: 10,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });
  const wastageLog = await createWastageLog(header, shopId, [
    { inventoryItemId: item.id, quantityWasted: 10, reason: 'expired' },
  ]);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({ wastageLogId: wastageLog.id });

  assert.equal(res.status, 201);
  assert.equal(res.body.wastageLogId, wastageLog.id);

  const flagRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', header);
  assert.deepEqual(flagRes.body, []);
});

test('resolving with a wastageLogId that does NOT cover this item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const otherItem = await createItem(header, shopId, { name: 'Bread', unit: 'each', quantityOnHand: 5 });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });
  // Wastage log covers a DIFFERENT item, not the one on this scan.
  const wastageLog = await createWastageLog(header, shopId, [
    { inventoryItemId: otherItem.id, quantityWasted: 1, reason: 'damaged' },
  ]);

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({ wastageLogId: wastageLog.id });

  assert.equal(res.status, 400);
});

test('resolving with a wastageLogId from another shop is a 404', async () => {
  const { header: headerA, shopId: shopAId } = await setupOwnerWithShop();
  const { header: headerB, shopId: shopBId } = await setupOwnerWithShop();

  const itemA = await createItem(headerA, shopAId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopAId, itemA.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const itemB = await createItem(headerB, shopBId, { name: 'Bread', unit: 'each', quantityOnHand: 5 });
  const foreignWastageLog = await createWastageLog(headerB, shopBId, [
    { inventoryItemId: itemB.id, quantityWasted: 1, reason: 'damaged' },
  ]);

  const res = await request(app)
    .post(`/api/shops/${shopAId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', headerA)
    .send({ wastageLogId: foreignWastageLog.id });

  assert.equal(res.status, 404);
});

test('resolving a scan that has not expired yet is a 400', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2099-01-01',
  });

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 400);
});

test('resolving the same scan twice is a 409', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const first = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({});
  assert.equal(first.status, 201);

  const second = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({});
  assert.equal(second.status, 409);
});

test('resolving a scan that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/00000000-0000-0000-0000-000000000000/resolve`)
    .set('Authorization', header)
    .send({});

  assert.equal(res.status, 404);
});

// --- Reading a resolution ---

test('GET resolution returns the resolution once resolved', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });
  await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', header)
    .send({ notes: 'dealt with' });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/${scanId}/resolution`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.scanId, scanId);
  assert.equal(res.body.notes, 'dealt with');
});

test('GET resolution for a scan not yet resolved is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/${scanId}/resolution`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

// --- Permissions: same PERFORM_HEALTH_SAFETY gate as the rest of 8.2/8.3 ---

test('a Shift Manager can read the flag list and resolve, via PERFORM_HEALTH_SAFETY', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const item = await createItem(header, shopId, {
    name: 'Milk',
    unit: 'L',
    sku: 'MILK-001',
    shelfLifeDays: 14,
  });
  const scanId = await insertScanDirectly(shopId, item.id, {
    sku: 'MILK-001',
    state: 'sealed',
    shelfLifeDaysUsed: 14,
    expiresOn: '2020-01-01',
  });

  const shiftManager = await insertStaff(shopId, 'shift_manager');
  const shiftManagerHeader = await staffHeaderFor(shopId, shiftManager.staffIdCode);

  const flagRes = await request(app)
    .get(`/api/shops/${shopId}/inventory-scans/expired`)
    .set('Authorization', shiftManagerHeader);
  assert.equal(flagRes.status, 200);
  assert.equal(flagRes.body.length, 1);

  const resolveRes = await request(app)
    .post(`/api/shops/${shopId}/inventory-scans/${scanId}/resolve`)
    .set('Authorization', shiftManagerHeader)
    .send({});
  assert.equal(resolveRes.status, 201);
});

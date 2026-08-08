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
    [uniqueEmail('po-owner'), passwordHash]
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
      name: 'PO Test Ltd',
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

async function createSupplier(header, shopId, name = 'Bidfood') {
  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name });
  return res.body;
}

async function createItem(header, shopId, name = 'Chicken Breast') {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name, unit: 'kg' });
  return res.body;
}

// --- Create ---

test('POST logs a purchase order with priced and unpriced line items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast');
  const flour = await createItem(header, shopId, 'Flour');

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: supplier.id,
      items: [
        { inventoryItemId: chicken.id, quantity: 10, unitCost: 2.5 },
        { inventoryItemId: flour.id, quantity: 25 },
      ],
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.supplierName, 'Bidfood');
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.totalCost, 25);
  const flourLine = res.body.items.find((i) => i.itemName === 'Flour');
  assert.equal(flourLine.unitCost, null);
});

test('POST rejects a purchase order with no line items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId: supplier.id, items: [] });

  assert.equal(res.status, 400);
});

test('POST rejects a purchase order with a duplicate item in the line items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: supplier.id,
      items: [
        { inventoryItemId: chicken.id, quantity: 10 },
        { inventoryItemId: chicken.id, quantity: 5 },
      ],
    });

  assert.equal(res.status, 400);
});

test('POST rejects an unknown supplier', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chicken = await createItem(header, shopId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: crypto.randomUUID(),
      items: [{ inventoryItemId: chicken.id, quantity: 10 }],
    });

  assert.equal(res.status, 404);
});

test('POST rejects a line item referencing an inventory item from another shop', async () => {
  const ownerA = await setupOwnerWithShop();
  const supplierA = await createSupplier(ownerA.header, ownerA.shopId);
  const ownerB = await setupOwnerWithShop();
  const itemB = await createItem(ownerB.header, ownerB.shopId);

  const res = await request(app)
    .post(`/api/shops/${ownerA.shopId}/purchase-orders`)
    .set('Authorization', ownerA.header)
    .send({
      supplierId: supplierA.id,
      items: [{ inventoryItemId: itemB.id, quantity: 10 }],
    });

  assert.equal(res.status, 404);
});

test('POST accepts a backdated orderedAt for logging a past order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);
  const pastDate = '2026-01-15T09:00:00.000Z';

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({
      supplierId: supplier.id,
      orderedAt: pastDate,
      items: [{ inventoryItemId: chicken.id, quantity: 10 }],
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.orderedAt, pastDate);
});

// --- List / Get ---

test('GET lists purchase orders with supplier name and totalCost', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);
  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId: supplier.id, items: [{ inventoryItemId: chicken.id, quantity: 10, unitCost: 2 }] });

  const res = await request(app).get(`/api/shops/${shopId}/purchase-orders`).set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].supplierName, 'Bidfood');
  assert.equal(res.body[0].totalCost, 20);
  assert.equal(res.body[0].itemCount, 1);
});

test('GET a single purchase order returns full line item detail', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId: supplier.id, items: [{ inventoryItemId: chicken.id, quantity: 10, unitCost: 2 }] });

  const res = await request(app)
    .get(`/api/shops/${shopId}/purchase-orders/${createRes.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].itemName, 'Chicken Breast');
  assert.equal(res.body.items[0].quantity, 10);
});

test('a purchase order from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const supplierA = await createSupplier(ownerA.header, ownerA.shopId);
  const itemA = await createItem(ownerA.header, ownerA.shopId);
  const poRes = await request(app)
    .post(`/api/shops/${ownerA.shopId}/purchase-orders`)
    .set('Authorization', ownerA.header)
    .send({ supplierId: supplierA.id, items: [{ inventoryItemId: itemA.id, quantity: 10 }] });
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${ownerB.shopId}/purchase-orders/${poRes.body.id}`)
    .set('Authorization', ownerB.header);

  assert.equal(res.status, 404);
});

// --- Delete ---

test('DELETE removes a purchase order; it disappears from listings', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId: supplier.id, items: [{ inventoryItemId: chicken.id, quantity: 10 }] });

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${createRes.body.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app).get(`/api/shops/${shopId}/purchase-orders`).set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('there is no PATCH endpoint - purchase orders are logging only', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId);
  const createRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId: supplier.id, items: [{ inventoryItemId: chicken.id, quantity: 10 }] });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/purchase-orders/${createRes.body.id}`)
    .set('Authorization', header)
    .send({ notes: 'trying to edit' });

  assert.equal(res.status, 404); // no route registered for PATCH here
});
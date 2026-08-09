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
    [uniqueEmail('order-additems-owner'), passwordHash]
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
      name: `Order Add Items Test Ltd ${crypto.randomUUID()}`,
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

async function createCategory(header, name) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name });
  return res.body.id;
}

async function createMenuItem(header, categoryId, name, price) {
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId, name, price });
  return res.body.id;
}

async function createModifierGroup(header, name, minSelections, maxSelections) {
  const res = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name, minSelections, maxSelections });
  return res.body.id;
}

async function createModifierOption(header, groupId, name, priceDelta) {
  const res = await request(app)
    .post(`/api/companies/mine/modifier-groups/${groupId}/options`)
    .set('Authorization', header)
    .send({ name, priceDelta });
  return res.body.id;
}

async function attachModifierGroupToItem(header, itemId, groupId) {
  await request(app)
    .post(`/api/companies/mine/menu-items/${itemId}/modifier-groups/${groupId}`)
    .set('Authorization', header);
}

async function setItemOverride(header, shopId, menuItemId, data) {
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${menuItemId}`)
    .set('Authorization', header)
    .send(data);
}

async function createOrder(header, shopId, body) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send(body);
  return res.body;
}

async function addItems(header, shopId, orderId, items) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/items`)
    .set('Authorization', header)
    .send({ items });
}

// --- Core behavior ---

test('adding items to an open order returns both original and new items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  assert.equal(order.items.length, 1);
  assert.equal(order.subtotal, 8);

  const res = await addItems(header, shopId, order.id, [{ menuItemId: friesId, quantity: 2 }]);

  assert.equal(res.status, 201);
  assert.equal(res.body.id, order.id);
  assert.equal(res.body.items.length, 2);
  // 8 (original burger) + 3*2 (new fries) = 14
  assert.equal(res.body.subtotal, 14);
});

test('items added later persist when the order is fetched again', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await addItems(header, shopId, order.id, [{ menuItemId: friesId, quantity: 1 }]);

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders/${order.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.subtotal, 11);
});

test('multiple add-items calls keep accumulating, not overwriting', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });
  await addItems(header, shopId, order.id, [{ menuItemId: itemId, quantity: 1 }]);
  await addItems(header, shopId, order.id, [{ menuItemId: itemId, quantity: 1 }]);

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders/${order.id}`)
    .set('Authorization', header);

  assert.equal(res.body.items.length, 3);
  assert.equal(res.body.subtotal, 24);
});

// --- Reuses 9.1's validation rules exactly ---

test('a disabled item cannot be added, same rule as order creation', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const disabledId = await createMenuItem(header, categoryId, 'Discontinued', 5);
  await setItemOverride(header, shopId, disabledId, { isEnabled: false });

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await addItems(header, shopId, order.id, [{ menuItemId: disabledId, quantity: 1 }]);

  assert.equal(res.status, 400);
});

test('modifier min/max is enforced on added items too', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza', 8);
  const groupId = await createModifierGroup(header, 'Size', 1, 1);
  await createModifierOption(header, groupId, 'Small', 0);
  await attachModifierGroupToItem(header, pizzaId, groupId);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await addItems(header, shopId, order.id, [{ menuItemId: pizzaId, quantity: 1 }]);

  assert.equal(res.status, 400);
});

test('a nonexistent menu item is a 404 when added, same as at creation', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await addItems(header, shopId, order.id, [
    { menuItemId: '00000000-0000-0000-0000-000000000000', quantity: 1 },
  ]);

  assert.equal(res.status, 404);
});

test('adding zero items is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const res = await addItems(header, shopId, order.id, []);

  assert.equal(res.status, 400);
});

// --- Scoping ---

test('adding items to an order that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await addItems(header, shopId, '00000000-0000-0000-0000-000000000000', [
    { menuItemId: '00000000-0000-0000-0000-000000000000', quantity: 1 },
  ]);

  assert.equal(res.status, 404);
});

test('adding items to an order from another shop is a 404', async () => {
  const { header: headerA, shopId: shopAId } = await setupOwnerWithShop();
  const { header: headerB, shopId: shopBId } = await setupOwnerWithShop();
  const categoryId = await createCategory(headerA, 'Mains');
  const itemId = await createMenuItem(headerA, categoryId, 'Burger', 8);
  const order = await createOrder(headerA, shopAId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const res = await addItems(headerB, shopBId, order.id, [{ menuItemId: itemId, quantity: 1 }]);

  assert.equal(res.status, 404);
});

// --- Permissions ---

test('a Server (has ACCESS_TILL) can add items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await addItems(serverHeader, shopId, order.id, [{ menuItemId: itemId, quantity: 1 }]);

  assert.equal(res.status, 201);
});

test('a Chef (no ACCESS_TILL) cannot add items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await addItems(chefHeader, shopId, order.id, [{ menuItemId: itemId, quantity: 1 }]);

  assert.equal(res.status, 403);
});

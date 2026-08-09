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
    [uniqueEmail('order-cancel-owner'), passwordHash]
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
      name: `Order Cancel Test Ltd ${crypto.randomUUID()}`,
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

async function createOrder(header, shopId, body) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send(body);
  return res.body;
}

async function cancelOrder(header, shopId, orderId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/cancel`)
    .set('Authorization', header)
    .send(body);
}

async function voidItem(header, shopId, orderId, orderItemId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/void`)
    .set('Authorization', header)
    .send(body);
}

async function setItemDiscount(header, shopId, orderId, orderItemId, body) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/discount`)
    .set('Authorization', header)
    .send(body);
}

// --- Order-level cancellation ---

test('cancelling an order sets status and cancellation details, totals unchanged', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await cancelOrder(header, shopId, order.id, {
    wasPrepped: true,
    reason: 'Customer changed mind',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.cancellation.wasPrepped, true);
  assert.equal(res.body.cancellation.reason, 'Customer changed mind');
  assert.equal(res.body.subtotal, 10);
  assert.equal(res.body.total, 10);
});

test('cancelling an already-cancelled order is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await cancelOrder(header, shopId, order.id, { wasPrepped: false });

  const res = await cancelOrder(header, shopId, order.id, { wasPrepped: false });

  assert.equal(res.status, 400);
});

test('cancelling a nonexistent order is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await cancelOrder(header, shopId, '00000000-0000-0000-0000-000000000000', {
    wasPrepped: false,
  });

  assert.equal(res.status, 404);
});

test('adding items to a cancelled order is rejected (9.2 guard now reachable)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await cancelOrder(header, shopId, order.id, { wasPrepped: false });

  const res = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: burgerId, quantity: 1 }] });

  assert.equal(res.status, 400);
});

test('discounting a cancelled order is rejected (9.3 guard now reachable)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await cancelOrder(header, shopId, order.id, { wasPrepped: false });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/orders/${order.id}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'fixed', discountValue: 1 });

  assert.equal(res.status, 400);
});

// --- Line-item void ---

test('voiding one item excludes it from totals but keeps it in the response', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const burgerLine = order.items.find((item) => item.menuItemId === burgerId);

  const res = await voidItem(header, shopId, order.id, burgerLine.id, {
    wasPrepped: false,
    reason: 'Wrong item',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.subtotal, 5);
  assert.equal(res.body.total, 5);
  const voidedLine = res.body.items.find((item) => item.id === burgerLine.id);
  assert.equal(voidedLine.void.reason, 'Wrong item');
  assert.equal(voidedLine.void.wasPrepped, false);
  const activeLine = res.body.items.find((item) => item.id !== burgerLine.id);
  assert.equal(activeLine.void, null);
});

test('voiding the last remaining active item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await voidItem(header, shopId, order.id, order.items[0].id, { wasPrepped: false });

  assert.equal(res.status, 400);
});

test('voiding an already-voided item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const burgerLine = order.items.find((item) => item.menuItemId === burgerId);
  await voidItem(header, shopId, order.id, burgerLine.id, { wasPrepped: false });

  const res = await voidItem(header, shopId, order.id, burgerLine.id, { wasPrepped: false });

  assert.equal(res.status, 400);
});

test('voiding an item that does not belong to the order is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const orderA = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  const orderB = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await voidItem(header, shopId, orderA.id, orderB.items[0].id, { wasPrepped: false });

  assert.equal(res.status, 404);
});

test('voiding an item on a cancelled order is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  await cancelOrder(header, shopId, order.id, { wasPrepped: false });

  const res = await voidItem(header, shopId, order.id, order.items[0].id, { wasPrepped: false });

  assert.equal(res.status, 400);
});

test('discounting a voided item is rejected (9.4 -> 9.3 integration)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const burgerLine = order.items.find((item) => item.menuItemId === burgerId);
  await voidItem(header, shopId, order.id, burgerLine.id, { wasPrepped: false });

  const res = await setItemDiscount(header, shopId, order.id, burgerLine.id, {
    discountType: 'fixed',
    discountValue: 1,
  });

  assert.equal(res.status, 400);
});

// --- Permissions ---

test('a Server (has ACCESS_TILL) can cancel an order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await cancelOrder(serverHeader, shopId, order.id, { wasPrepped: false });

  assert.equal(res.status, 200);
});

test('a Chef (no ACCESS_TILL) cannot void an item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });

  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await voidItem(chefHeader, shopId, order.id, order.items[0].id, {
    wasPrepped: false,
  });

  assert.equal(res.status, 403);
});

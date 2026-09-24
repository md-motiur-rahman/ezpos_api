import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { enablePaymentMethod } from '../helpers/billing.js';

/**
 * `GET /api/shops/:shopId/kds/orders` (Module 15.2) - the ticket board's
 * initial snapshot. A plain REST endpoint (unlike kdsSocket.test.js's own
 * suite, this needs none of that file's real-http.Server-plus-`ws`-client
 * harness), so this is its own file rather than growing that one further -
 * the same "one file per concern, fixtures duplicated rather than shared
 * until truly reused at scale" convention orderItemStatus.test.js (10.2's
 * own sibling VIEW_KDS-gated endpoint) already follows.
 */

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('kds-orders-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
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
      vatRegistered: false,
    });
  return res.body.id;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `KDS Orders Test Ltd ${crypto.randomUUID()}`,
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
  await enablePaymentMethod(header);
  const shopId = await createShop(header, 'Test Shop');
  return { header, shopId };
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

async function createMenuItem(header, name, price) {
  const catRes = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: `Mains ${crypto.randomUUID()}` });
  const itemRes = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: catRes.body.id, name, price });
  return itemRes.body.id;
}

async function createOrder(header, shopId, itemId, quantity = 1) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: itemId, quantity }] });
  return res.body;
}

function listKdsOrders(header, shopId) {
  return request(app).get(`/api/shops/${shopId}/kds/orders`).set('Authorization', header);
}

function setItemStatus(header, shopId, orderId, orderItemId, status) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/status`)
    .set('Authorization', header)
    .send({ status });
}

test('an open order with a pending item appears on the board, money-narrowed', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const order = await createOrder(header, shopId, itemId);

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  const ticket = res.body[0];
  assert.equal(ticket.id, order.id);
  assert.equal(ticket.orderNumber, order.orderNumber);
  assert.equal(ticket.kitchenStatus, 'pending');
  assert.equal(ticket.items[0].itemName, 'Burger');

  assert.equal(ticket.subtotal, undefined);
  assert.equal(ticket.total, undefined);
  assert.equal(ticket.payments, undefined);
  assert.equal(ticket.items[0].unitPrice, undefined);
});

test('a Chef (no ACCESS_TILL) can see the board even though GET /orders would 403 them', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  await createOrder(header, shopId, itemId);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const kdsRes = await listKdsOrders(chefHeader, shopId);
  assert.equal(kdsRes.status, 200);
  assert.equal(kdsRes.body.length, 1);

  const ordersRes = await request(app)
    .get(`/api/shops/${shopId}/orders`)
    .set('Authorization', chefHeader);
  assert.equal(ordersRes.status, 403);
});

test('a Server (no VIEW_KDS by default) is refused with 403', async () => {
  const { shopId } = await setupOwnerWithShop();
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await listKdsOrders(serverHeader, shopId);
  assert.equal(res.status, 403);
});

test('a fully-served order drops off the board', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const order = await createOrder(header, shopId, itemId);

  for (const status of ['in_progress', 'ready', 'served']) {
    await setItemStatus(header, shopId, order.id, order.items[0].id, status);
  }

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('a cancelled order does not appear', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const order = await createOrder(header, shopId, itemId);

  const cancelRes = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false, reason: 'Customer changed their mind' });
  assert.equal(cancelRes.status, 200);

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test('a voided line neither blocks the ticket from the board nor holds its status back', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const order = await createOrder(header, shopId, itemId);
  // 9.4 refuses to void the LAST active item on an order (cancel the order
  // instead), so this needs a second line for the void to be reachable at
  // all - kdsOrderView.js's own deriveKitchenStatus doc names this exact
  // guard as why a live order always has at least one active item.
  const friesId = await createMenuItem(header, 'Fries', 3.5);
  const addRes = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: friesId, quantity: 1 }] });
  const friesLine = addRes.body.items.find((item) => item.itemName === 'Fries');

  // Advance the burger to 'ready' BEFORE voiding the fries - if the voided
  // line still counted, its 'pending' status would wrongly hold the whole
  // ticket at 'pending' instead of the burger's own 'ready'.
  assert.equal((await setItemStatus(header, shopId, order.id, order.items[0].id, 'in_progress')).status, 200);
  assert.equal((await setItemStatus(header, shopId, order.id, order.items[0].id, 'ready')).status, 200);
  const voidRes = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items/${friesLine.id}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: false, reason: 'Kitchen ran out' });
  assert.equal(voidRes.status, 200);

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].kitchenStatus, 'ready');
});

test('an order with one served item and one still-pending item stays on the board as pending', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const order = await createOrder(header, shopId, itemId, 2);
  // 9.2 append a second, different line so one can be served while the
  // other stays pending.
  const friesId = await createMenuItem(header, 'Fries', 3.5);
  const addRes = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: friesId, quantity: 1 }] });
  const friesLine = addRes.body.items.find((item) => item.itemName === 'Fries');

  for (const status of ['in_progress', 'ready', 'served']) {
    assert.equal((await setItemStatus(header, shopId, order.id, friesLine.id, status)).status, 200);
  }

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].kitchenStatus, 'pending'); // the burger line never advanced
});

test('older tickets come first', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  const first = await createOrder(header, shopId, itemId);
  const second = await createOrder(header, shopId, itemId);

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].id, first.id);
  assert.equal(res.body[1].id, second.id);
});

test("a shop's board never shows another shop's orders", async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const otherShopId = await createShop(header, 'A Second Shop');
  const itemId = await createMenuItem(header, 'Burger', 8.5);
  await createOrder(header, otherShopId, itemId);

  const res = await listKdsOrders(header, shopId);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

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
    [uniqueEmail('order-item-status-owner'), passwordHash]
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
      name: `Order Item Status Test Ltd ${crypto.randomUUID()}`,
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

function setStatus(header, shopId, orderId, orderItemId, status) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/status`)
    .set('Authorization', header)
    .send({ status });
}

/** A one-item takeaway order - the baseline most cases below build on. */
async function tenPoundOrder(header, shopId) {
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  return { order, burgerId };
}

// --- Baseline: additive, defaults to 'pending' ---

test('a newly created order item defaults to pending status with no audit fields set', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  assert.equal(order.items[0].status, 'pending');
  assert.equal(order.items[0].statusUpdatedAt, null);
  assert.equal(order.items[0].statusUpdatedByActorType, null);
  assert.equal(order.items[0].statusUpdatedByActorId, null);
});

// --- Setting status ---

test('setting a status updates the item and stamps the actor/time', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  const res = await setStatus(header, shopId, order.id, itemId, 'in_progress');

  assert.equal(res.status, 200);
  const item = res.body.items.find((i) => i.id === itemId);
  assert.equal(item.status, 'in_progress');
  assert.ok(item.statusUpdatedAt, 'statusUpdatedAt must be stamped');
  assert.equal(item.statusUpdatedByActorType, 'owner');
});

test('every status in the fixed list is accepted', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  for (const status of ['in_progress', 'ready', 'served', 'pending']) {
    const res = await setStatus(header, shopId, order.id, itemId, status);
    assert.equal(res.status, 200, `expected ${status} to be accepted`);
    assert.equal(res.body.items.find((i) => i.id === itemId).status, status);
  }
});

test('an unrecognised status value is rejected (400)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  const res = await setStatus(header, shopId, order.id, itemId, 'on_fire');

  assert.equal(res.status, 400);
});

// --- Transitions are UNRESTRICTED (confirmed directly) ---

test('status can move backward, e.g. correcting a mis-tap from ready back to in_progress', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  await setStatus(header, shopId, order.id, itemId, 'ready');
  const back = await setStatus(header, shopId, order.id, itemId, 'in_progress');

  assert.equal(back.status, 200);
  assert.equal(back.body.items.find((i) => i.id === itemId).status, 'in_progress');
});

test('status can jump directly from pending to served, skipping intermediate states', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  const res = await setStatus(header, shopId, order.id, itemId, 'served');

  assert.equal(res.status, 200);
  assert.equal(res.body.items.find((i) => i.id === itemId).status, 'served');
});

// --- Guards ---

test('status cannot be set on a cancelled order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  const cancelled = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });
  assert.equal(cancelled.status, 200);

  const res = await setStatus(header, shopId, order.id, itemId, 'ready');
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /cancelled/i);
});

test('status CAN still be set on a paid order - payment does not stop the kitchen', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;

  const paid = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/payments`)
    .set('Authorization', header)
    .send({ method: 'cash', amountTendered: 10 });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.status, 'paid');

  const res = await setStatus(header, shopId, order.id, itemId, 'in_progress');
  assert.equal(res.status, 200, 'a paid order must still allow kitchen prep to progress');
  assert.equal(res.body.items.find((i) => i.id === itemId).status, 'in_progress');
});

test('status cannot be set on a voided item', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const friesItemId = order.items.find((i) => i.menuItemId === friesId).id;

  const voided = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items/${friesItemId}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: false });
  assert.equal(voided.status, 200);

  const res = await setStatus(header, shopId, order.id, friesItemId, 'ready');
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /voided/i);
});

test('a status update for an item on a different order returns 404 (cross-order scoping)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order: orderA } = await tenPoundOrder(header, shopId);
  const { order: orderB } = await tenPoundOrder(header, shopId);
  const itemFromOrderA = orderA.items[0].id;

  const res = await setStatus(header, shopId, orderB.id, itemFromOrderA, 'ready');

  assert.equal(res.status, 404);
});

test('a status update for a non-existent item returns 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await setStatus(header, shopId, order.id, crypto.randomUUID(), 'ready');

  assert.equal(res.status, 404);
});

// --- Response contract ---

/**
 * REVISED after the 10.2 permission-leak fix. This test previously asserted
 * that this endpoint returned the FULL order detail unchanged (unitPrice,
 * lineTotal, subtotal, total). That was the leak: this route is the one order
 * endpoint gated on VIEW_KDS rather than ACCESS_TILL, so a Chef - who is
 * deliberately 403'd from GET /orders/:id - was being handed the order's
 * money through it anyway. It now returns the KDS-safe view
 * (kdsOrderView.js), so the assertions below check the two properties that
 * actually matter: the kitchen still gets everything it needs to cook, and
 * none of the money comes with it.
 */
test('a status change returns everything the kitchen needs, with no monetary data', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const itemId = order.items[0].id;
  const before = order.items[0];

  const res = await setStatus(header, shopId, order.id, itemId, 'ready');
  const after = res.body.items.find((i) => i.id === itemId);

  // What the kitchen needs is intact and still matches the created order.
  assert.equal(after.itemName, before.itemName);
  assert.equal(after.quantity, before.quantity);
  assert.equal(after.status, 'ready');
  assert.equal(after.void, null);
  assert.equal(res.body.id, order.id);
  assert.equal(res.body.type, order.type);
  assert.equal(res.body.status, order.status);

  // No money, at any nesting level.
  assert.equal(after.unitPrice, undefined);
  assert.equal(after.lineTotal, undefined);
  assert.equal(after.total, undefined);
  assert.equal(after.discount, undefined);
  assert.equal(res.body.subtotal, undefined);
  assert.equal(res.body.total, undefined);
  assert.equal(res.body.payments, undefined);
  assert.equal(res.body.balanceDue, undefined);
  assert.equal(res.body.vatAmount, undefined);
});

test('a Chef cannot reach the order payment ledger through the status endpoint', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  // Pay the order first, so there is a real payment record to leak.
  const paid = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/payments`)
    .set('Authorization', header)
    .send({ method: 'cash', amountTendered: 20 });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.payments.length, 1, 'the payment must exist to be leakable');

  // The Chef is 403'd from the ACCESS_TILL-gated read...
  const denied = await request(app)
    .get(`/api/shops/${shopId}/orders/${order.id}`)
    .set('Authorization', chefHeader);
  assert.equal(denied.status, 403);

  // ...so the VIEW_KDS-gated route must not hand them the same data instead.
  const res = await setStatus(chefHeader, shopId, order.id, order.items[0].id, 'ready');
  assert.equal(res.status, 200);
  assert.equal(res.body.payments, undefined, 'payment ledger must not leak via VIEW_KDS');
  assert.equal(res.body.amountPaid, undefined);
  assert.equal(res.body.balanceDue, undefined);
  assert.equal(res.body.total, undefined);
  assert.equal(
    JSON.stringify(res.body).includes('amountTendered'),
    false,
    'no payment field may appear anywhere in the payload'
  );
});

// --- Permissions ---

test('a Chef (VIEW_KDS by default, no ACCESS_TILL) can set item status', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await setStatus(chefHeader, shopId, order.id, order.items[0].id, 'in_progress');

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].statusUpdatedByActorType, 'staff');
  assert.equal(res.body.items[0].statusUpdatedByActorId, chef.id);
});

test('a Server (no VIEW_KDS by default) cannot set item status', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await setStatus(serverHeader, shopId, order.id, order.items[0].id, 'in_progress');

  assert.equal(res.status, 403);
});

// --- KDS push (10.1's channel, reused) ---

test('a status change pushes order.item_status_changed to a connected KDS', async () => {
  const http = await import('node:http');
  const { WebSocket } = await import('ws');
  const { attachKdsSocketServer } = await import('../../src/modules/kds/kdsSocket.js');

  const server = http.createServer(app);
  const kds = attachKdsSocketServer(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/shops/${shopId}/kds/socket`, {
    headers: { Authorization: header },
  });
  ws.on('error', () => {});

  try {
    // Consume the initial kds.connected handshake.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting to connect')), 5000);
      ws.once('message', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const pushed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the push')), 5000);
      ws.once('message', (raw) => {
        clearTimeout(timer);
        resolve(JSON.parse(raw.toString()));
      });
    });

    const res = await setStatus(header, shopId, order.id, order.items[0].id, 'ready');
    assert.equal(res.status, 200);

    const event = await pushed;
    assert.equal(event.type, 'order.item_status_changed');
    assert.equal(event.order.id, order.id);
    assert.equal(event.order.items[0].status, 'ready');
  } finally {
    try {
      ws.terminate();
    } catch {
      // already closed
    }
    kds.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- Derived ticket-level kitchen status (KDS roll-up) ---

/**
 * The Chef still updates items one at a time; kitchenStatus is the ticket-level
 * roll-up the KDS shows. It is the LOWEST status across active items - a ticket
 * is only 'ready' once every line is, otherwise the kitchen would be told a
 * ticket is done while food is still on the pass.
 */
async function twoItemOrder(header, shopId) {
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  return {
    order,
    burgerItemId: order.items.find((i) => i.menuItemId === burgerId).id,
    friesItemId: order.items.find((i) => i.menuItemId === friesId).id,
  };
}

test('a brand-new ticket rolls up to pending, and carries the order number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId } = await twoItemOrder(header, shopId);

  const res = await setStatus(header, shopId, order.id, burgerItemId, 'pending');

  assert.equal(res.body.kitchenStatus, 'pending');
  assert.equal(res.body.orderNumber, order.orderNumber);
  assert.ok(res.body.orderNumber, 'the KDS must get a human-readable number, not just a UUID');
});

test('one item moving forward pulls the ticket to in_progress, but not to ready', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId } = await twoItemOrder(header, shopId);

  const res = await setStatus(header, shopId, order.id, burgerItemId, 'ready');

  // Burger ready, fries still pending -> the TICKET is not ready.
  assert.equal(res.body.kitchenStatus, 'pending', 'the slowest line governs the ticket');
});

test('a ticket reads ready only once every line is ready', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId, friesItemId } = await twoItemOrder(header, shopId);

  await setStatus(header, shopId, order.id, burgerItemId, 'ready');
  const res = await setStatus(header, shopId, order.id, friesItemId, 'ready');

  assert.equal(res.body.kitchenStatus, 'ready');
});

test('a ticket reads in_progress while any line is being worked', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId, friesItemId } = await twoItemOrder(header, shopId);

  await setStatus(header, shopId, order.id, burgerItemId, 'served');
  const res = await setStatus(header, shopId, order.id, friesItemId, 'in_progress');

  assert.equal(res.body.kitchenStatus, 'in_progress');
});

test('a voided line does not hold the ticket back', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId, friesItemId } = await twoItemOrder(header, shopId);

  // Fries voided while still pending; burger ready. The ticket is ready,
  // because nobody is making the fries any more.
  const voided = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items/${friesItemId}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: false });
  assert.equal(voided.status, 200);

  const res = await setStatus(header, shopId, order.id, burgerItemId, 'ready');
  assert.equal(res.body.kitchenStatus, 'ready');
});

test('kitchenStatus is a separate field from the order business status', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerItemId, friesItemId } = await twoItemOrder(header, shopId);

  await setStatus(header, shopId, order.id, burgerItemId, 'ready');
  await setStatus(header, shopId, order.id, friesItemId, 'ready');

  const paid = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/payments`)
    .set('Authorization', header)
    .send({ method: 'cash', amountTendered: 13 });
  assert.equal(paid.status, 201);

  const res = await setStatus(header, shopId, order.id, burgerItemId, 'served');

  // Two different meanings, two different names - the payment state and the
  // prep state must never be conflated into one `status`.
  assert.equal(res.body.status, 'paid', 'business/payment state');
  assert.equal(res.body.kitchenStatus, 'ready', 'prep state (fries still ready, not served)');
});

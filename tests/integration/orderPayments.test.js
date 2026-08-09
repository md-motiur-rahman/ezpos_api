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
    [uniqueEmail('order-payment-owner'), passwordHash]
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
      name: `Order Payment Test Ltd ${crypto.randomUUID()}`,
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

async function pay(header, shopId, orderId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/payments`)
    .set('Authorization', header)
    .send(body);
}

/** A £10 takeaway order, the baseline for most cases below. */
async function tenPoundOrder(header, shopId) {
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  return { order, burgerId };
}

// --- Baseline: an unpaid order is unchanged by 9.5 ---

test('a brand-new order reports no payments and a full balance due', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  assert.deepEqual(order.payments, []);
  assert.equal(order.amountPaid, 0);
  assert.equal(order.balanceDue, 10);
  assert.equal(order.status, 'open');
});

// --- Cash ---

test('exact cash payment marks the order paid with no change', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.payments.length, 1);
  assert.equal(res.body.payments[0].method, 'cash');
  assert.equal(res.body.payments[0].amount, 10);
  assert.equal(res.body.payments[0].amountTendered, 10);
  assert.equal(res.body.payments[0].change, 0);
});

test('over-tendered cash credits only what is owed and returns the change', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 20 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  // Only the £10 owed is credited, never the full £20 tendered.
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.payments[0].amountTendered, 20);
  assert.equal(res.body.payments[0].amount, 10);
  assert.equal(res.body.payments[0].change, 10);
});

test('partial cash payment moves the order to partially_paid', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'partially_paid');
  assert.equal(res.body.amountPaid, 4);
  assert.equal(res.body.balanceDue, 6);
  assert.equal(res.body.payments[0].change, 0);
});

// --- Card ---

test('exact card payment marks the order paid and stores a provider reference', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'card', amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.payments[0].method, 'card');
  assert.equal(res.body.payments[0].amountTendered, null);
  assert.equal(res.body.payments[0].change, null);
  assert.ok(res.body.payments[0].providerReference);
});

test('a card payment exceeding the balance is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'card', amount: 10.01 });

  assert.equal(res.status, 400);
});

// --- Split / partial payment ---

test('split payment across cash and card settles the order exactly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const first = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 3 });
  assert.equal(first.body.status, 'partially_paid');
  assert.equal(first.body.balanceDue, 7);

  const second = await pay(header, shopId, order.id, { method: 'card', amount: 7 });

  assert.equal(second.status, 201);
  assert.equal(second.body.status, 'paid');
  assert.equal(second.body.amountPaid, 10);
  assert.equal(second.body.balanceDue, 0);
  assert.equal(second.body.payments.length, 2);
});

test('a second payment can never exceed the remaining balance', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 6 });

  // £6 already paid, so £4 remains - a £5 card charge must be refused.
  const res = await pay(header, shopId, order.id, { method: 'card', amount: 5 });

  assert.equal(res.status, 400);
});

test('over-tendered cash on the FINAL split payment credits only the remainder', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'card', amount: 6 });

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.amountPaid, 10); // 6 + 4, not 6 + 10
  assert.equal(res.body.payments[1].amount, 4);
  assert.equal(res.body.payments[1].change, 6);
});

// --- Status transitions and locking ---

test('paying a fully-paid order again is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 5 });

  assert.equal(res.status, 400);
});

test('paying a cancelled order is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 400);
});

test('a partially-paid order is LOCKED against adding items (9.2 guard)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, burgerId } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });

  const res = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: burgerId, quantity: 1 }] });

  assert.equal(res.status, 400);
});

test('a partially-paid order is LOCKED against discounting (9.3 guard)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });

  const res = await request(app)
    .patch(`/api/shops/${shopId}/orders/${order.id}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'fixed', discountValue: 1 });

  assert.equal(res.status, 400);
});

test('a partially-paid order is LOCKED against cancellation (9.4 guard)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });

  const res = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  assert.equal(res.status, 400);
});

// --- Interaction with 9.3's discounts and 9.4's voids ---

test('the balance due reflects a discount applied before payment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  await request(app)
    .patch(`/api/shops/${shopId}/orders/${order.id}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'percentage', discountValue: 20 });

  // £10 less 20% = £8 owed, so £8 settles it exactly.
  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 8 });

  assert.equal(res.status, 201);
  assert.equal(res.body.total, 8);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.balanceDue, 0);
});

test('the balance due excludes a voided item', async () => {
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
  const friesLine = order.items.find((item) => item.menuItemId === friesId);
  await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items/${friesLine.id}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  // £15 less the voided £5 fries = £10 owed.
  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.balanceDue, 0);
});

// --- Validation ---

test('a cash payment without amountTendered is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'cash', amount: 10 });

  assert.equal(res.status, 400);
});

test('an unknown payment method is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'crypto', amount: 10 });

  assert.equal(res.status, 400);
});

test('a zero or negative payment is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const zero = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 0 });
  const negative = await pay(header, shopId, order.id, { method: 'card', amount: -5 });

  assert.equal(zero.status, 400);
  assert.equal(negative.status, 400);
});

// --- Scoping and permissions ---

test('paying an order that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await pay(header, shopId, '00000000-0000-0000-0000-000000000000', {
    method: 'cash',
    amountTendered: 10,
  });

  assert.equal(res.status, 404);
});

test('a Server (has ACCESS_TILL) can take payment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await pay(serverHeader, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.payments[0].paidByActorType, 'staff');
});

test('a Chef (no ACCESS_TILL) cannot take payment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await pay(chefHeader, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 403);
});

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
    [uniqueEmail('order-refund-owner'), passwordHash]
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
      name: `Order Refund Test Ltd ${crypto.randomUUID()}`,
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

async function refund(header, shopId, orderId, paymentId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/payments/${paymentId}/refund`)
    .set('Authorization', header)
    .send(body);
}

/** A £10 takeaway order, the baseline for most cases below (same shape as 9.5's own helper). */
async function tenPoundOrder(header, shopId) {
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  return { order, burgerId };
}

/** A £10 order already settled in full by one cash payment - the starting point for most refunds. */
async function paidTenPoundOrder(header, shopId) {
  const { order, burgerId } = await tenPoundOrder(header, shopId);
  const paid = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });
  return { order: paid.body, paymentId: paid.body.payments[0].id, burgerId };
}

// --- Baseline: 9.6 is purely additive for an order that has never been refunded ---

test('a paid order with no refunds reports zero refunded and an unchanged net', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await paidTenPoundOrder(header, shopId);

  assert.equal(order.status, 'paid');
  // Every field 9.5 returned keeps its exact prior value...
  assert.equal(order.amountPaid, 10);
  assert.equal(order.balanceDue, 0);
  // ...and the new 9.6 fields are the neutral values.
  assert.equal(order.amountRefunded, 0);
  assert.equal(order.netAmountPaid, 10);
  assert.deepEqual(order.payments[0].refunds, []);
  assert.equal(order.payments[0].amountRefunded, 0);
  assert.equal(order.payments[0].netAmount, order.payments[0].amount);
});

// --- Cash refunds ---

test('a full cash refund marks the order refunded and reopens the balance', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const res = await refund(header, shopId, order.id, paymentId, {
    amount: 10,
    reason: 'Customer changed their mind',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'refunded');
  // amountPaid stays GROSS - 9.5's meaning is deliberately preserved.
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.amountRefunded, 10);
  assert.equal(res.body.netAmountPaid, 0);
  // The balance correctly reopens to the full total once the money is back out.
  assert.equal(res.body.balanceDue, 10);
  // The order's own contents are untouched by money coming back out.
  assert.equal(res.body.subtotal, 10);
  assert.equal(res.body.total, 10);

  const [payment] = res.body.payments;
  assert.equal(payment.refunds.length, 1);
  assert.equal(payment.refunds[0].amount, 10);
  assert.equal(payment.refunds[0].reason, 'Customer changed their mind');
  assert.equal(payment.refunds[0].refundedByActorType, 'owner');
  // Cash has no provider involvement at all.
  assert.equal(payment.refunds[0].providerReference, null);
  assert.equal(payment.amountRefunded, 10);
  assert.equal(payment.netAmount, 0);
});

test('a partial cash refund marks the order partially_refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const res = await refund(header, shopId, order.id, paymentId, { amount: 3.5 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'partially_refunded');
  assert.equal(res.body.amountRefunded, 3.5);
  assert.equal(res.body.netAmountPaid, 6.5);
  assert.equal(res.body.balanceDue, 3.5);
  assert.equal(res.body.payments[0].netAmount, 6.5);
});

test('two partial refunds against one payment accumulate and settle to refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const first = await refund(header, shopId, order.id, paymentId, { amount: 4 });
  assert.equal(first.status, 201);
  assert.equal(first.body.status, 'partially_refunded');

  const second = await refund(header, shopId, order.id, paymentId, { amount: 6 });

  assert.equal(second.status, 201);
  assert.equal(second.body.status, 'refunded');
  assert.equal(second.body.amountRefunded, 10);
  assert.equal(second.body.netAmountPaid, 0);
  // Both refunds are kept as their own immutable rows - never one row topped up.
  assert.equal(second.body.payments[0].refunds.length, 2);
  assert.deepEqual(
    second.body.payments[0].refunds.map((r) => r.amount),
    [4, 6]
  );
});

// --- Card refunds ---

test('a card refund stores its own provider reference, distinct from the charge', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);
  const paid = await pay(header, shopId, order.id, { method: 'card', amount: 10 });
  const payment = paid.body.payments[0];

  const res = await refund(header, shopId, order.id, payment.id, { amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'refunded');
  const refundRow = res.body.payments[0].refunds[0];
  assert.ok(refundRow.providerReference);
  // The REFUND's reference is its own value, not a copy of the charge's.
  assert.notEqual(refundRow.providerReference, payment.providerReference);
  // The original payment row is never mutated by a refund.
  assert.equal(res.body.payments[0].providerReference, payment.providerReference);
  assert.equal(res.body.payments[0].amount, 10);
});

// --- Over-refund rejection ---

test('a refund exceeding the payment amount is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const res = await refund(header, shopId, order.id, paymentId, { amount: 10.01 });

  assert.equal(res.status, 400);
  // Nothing was written and the status is untouched.
  const after = await request(app)
    .get(`/api/shops/${shopId}/orders/${order.id}`)
    .set('Authorization', header);
  assert.equal(after.body.status, 'paid');
  assert.equal(after.body.amountRefunded, 0);
  assert.deepEqual(after.body.payments[0].refunds, []);
});

test('a second refund exceeding the REMAINING refundable balance is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const first = await refund(header, shopId, order.id, paymentId, { amount: 6 });
  assert.equal(first.status, 201);

  // Only £4 remains refundable on this payment - £5 must not be allowed
  // through just because it is under the original £10.
  const second = await refund(header, shopId, order.id, paymentId, { amount: 5 });

  assert.equal(second.status, 400);
  assert.match(second.body.error.message, /4\.00/);
});

test('refunding an already fully-refunded payment is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  await refund(header, shopId, order.id, paymentId, { amount: 10 });
  const res = await refund(header, shopId, order.id, paymentId, { amount: 1 });

  // Blocked by the order-level status gate ('refunded' is not refundable).
  assert.equal(res.status, 400);
});

// --- Split payments: status is recomputed across EVERY payment, not just the one refunded ---

test('refunding only the cash leg of a split order leaves it partially_refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const cash = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });
  assert.equal(cash.body.status, 'partially_paid');
  const card = await pay(header, shopId, order.id, { method: 'card', amount: 6 });
  assert.equal(card.body.status, 'paid');

  const cashPaymentId = card.body.payments.find((p) => p.method === 'cash').id;

  const res = await refund(header, shopId, order.id, cashPaymentId, { amount: 4 });

  assert.equal(res.status, 201);
  // The cash payment is fully refunded, but £6 of card money is still held -
  // so the ORDER is only partially refunded.
  assert.equal(res.body.status, 'partially_refunded');
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.amountRefunded, 4);
  assert.equal(res.body.netAmountPaid, 6);
  assert.equal(res.body.balanceDue, 4);

  const cashPayment = res.body.payments.find((p) => p.method === 'cash');
  const cardPayment = res.body.payments.find((p) => p.method === 'card');
  assert.equal(cashPayment.netAmount, 0);
  // The untouched leg is completely unaffected.
  assert.equal(cardPayment.amountRefunded, 0);
  assert.equal(cardPayment.netAmount, 6);
});

test('refunding both legs of a split order settles it to refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });
  const card = await pay(header, shopId, order.id, { method: 'card', amount: 6 });

  const cashPaymentId = card.body.payments.find((p) => p.method === 'cash').id;
  const cardPaymentId = card.body.payments.find((p) => p.method === 'card').id;

  await refund(header, shopId, order.id, cashPaymentId, { amount: 4 });
  const res = await refund(header, shopId, order.id, cardPaymentId, { amount: 6 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'refunded');
  assert.equal(res.body.amountRefunded, 10);
  assert.equal(res.body.netAmountPaid, 0);
  assert.equal(res.body.balanceDue, 10);
});

test('a partially-paid order can be refunded and settles to refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const paid = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });
  assert.equal(paid.body.status, 'partially_paid');

  const res = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 4 });

  assert.equal(res.status, 201);
  // Everything that was actually paid has been given back.
  assert.equal(res.body.status, 'refunded');
  assert.equal(res.body.netAmountPaid, 0);
  assert.equal(res.body.balanceDue, 10);
});

// --- Refunds interact correctly with 9.3's discounts and 9.4's voids ---

test('a refund is capped by the discounted amount actually paid, not the pre-discount subtotal', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  await request(app)
    .patch(`/api/shops/${shopId}/orders/${order.id}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'percentage', discountValue: 50 });

  const paid = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 5 });
  assert.equal(paid.body.status, 'paid');
  assert.equal(paid.body.total, 5);

  // Only £5 was ever taken, so only £5 can come back - the £10 subtotal is
  // irrelevant to what is refundable.
  const tooMuch = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 6 });
  assert.equal(tooMuch.status, 400);

  const res = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 5 });
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'refunded');
  assert.equal(res.body.subtotal, 10);
  assert.equal(res.body.total, 5);
  assert.equal(res.body.balanceDue, 5);
});

// --- Status gates ---

test('an open (unpaid) order cannot be refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  const res = await refund(header, shopId, order.id, crypto.randomUUID(), { amount: 1 });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /open/);
});

test('a cancelled order cannot be refunded', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await tenPoundOrder(header, shopId);

  await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  const res = await refund(header, shopId, order.id, crypto.randomUUID(), { amount: 1 });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /cancelled/);
});

// --- Scoping ---

test('a payment belonging to a different order cannot be refunded through this one', async () => {
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

  const paidA = await pay(header, shopId, orderA.id, { method: 'cash', amountTendered: 10 });
  await pay(header, shopId, orderB.id, { method: 'cash', amountTendered: 10 });

  // Order A's payment id, addressed through order B's URL.
  const res = await refund(header, shopId, orderB.id, paidA.body.payments[0].id, { amount: 10 });

  assert.equal(res.status, 404);
});

test('refunding a payment that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order } = await paidTenPoundOrder(header, shopId);

  const res = await refund(header, shopId, order.id, crypto.randomUUID(), { amount: 1 });

  assert.equal(res.status, 404);
});

// --- Validation ---

test('a non-positive refund amount is rejected by validation', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const zero = await refund(header, shopId, order.id, paymentId, { amount: 0 });
  assert.equal(zero.status, 400);

  const negative = await refund(header, shopId, order.id, paymentId, { amount: -5 });
  assert.equal(negative.status, 400);
});

// --- Lock-out: existing 9.2/9.3/9.4/9.5 guards fire on the new statuses with NO code changes ---

test('a refunded order accepts no further payment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  await refund(header, shopId, order.id, paymentId, { amount: 10 });

  // The balance has reopened to £10, but PAYABLE_ORDER_STATUSES
  // deliberately excludes 'refunded' - settle such a case as a new order.
  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 10 });

  assert.equal(res.status, 400);
});

test('a refunded order cannot have items added, be discounted, or be cancelled', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId, burgerId } = await paidTenPoundOrder(header, shopId);

  await refund(header, shopId, order.id, paymentId, { amount: 10 });

  // All three are blocked by guards that already existed before 9.6 - not
  // one line in 9.2/9.3/9.4 changed for this to work.
  const added = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: burgerId, quantity: 1 }] });
  assert.equal(added.status, 400);

  const discounted = await request(app)
    .patch(`/api/shops/${shopId}/orders/${order.id}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'fixed', discountValue: 1 });
  assert.equal(discounted.status, 400);

  const cancelled = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });
  assert.equal(cancelled.status, 400);
});

// --- Permissions: APPLY_DISCOUNT, reused from 9.3 ---

test('a Manager (has APPLY_DISCOUNT) can issue a refund', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await refund(managerHeader, shopId, order.id, paymentId, { amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.payments[0].refunds[0].refundedByActorType, 'staff');
  assert.equal(res.body.payments[0].refunds[0].refundedByActorId, manager.id);
});

test('a Server (has ACCESS_TILL but not APPLY_DISCOUNT) cannot issue a refund', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { order, paymentId } = await paidTenPoundOrder(header, shopId);

  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  // The same Server is allowed to TAKE payment (9.5) - refunding is the
  // deliberately narrower gate.
  const res = await refund(serverHeader, shopId, order.id, paymentId, { amount: 10 });

  assert.equal(res.status, 403);
});

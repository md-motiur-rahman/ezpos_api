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
    [uniqueEmail('card-mode-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithCompany() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  const companyRes = await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `Card Mode Test Ltd ${crypto.randomUUID()}`,
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  return { header, company: companyRes.body };
}

async function setupOwnerWithShop() {
  const { header, company } = await setupOwnerWithCompany();
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
  return { header, company, shopId: shopRes.body.id };
}

function setCardMode(header, cardPaymentMode) {
  return request(app)
    .post('/api/companies/mine/card-payment-mode')
    .set('Authorization', header)
    .send({ cardPaymentMode });
}

async function tenPoundOrder(header, shopId) {
  const cat = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: cat.body.id, name: 'Burger', price: 10 });
  const order = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: item.body.id, quantity: 1 }] });
  return order.body;
}

function pay(header, shopId, orderId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/payments`)
    .set('Authorization', header)
    .send(body);
}

function refund(header, shopId, orderId, paymentId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/payments/${paymentId}/refund`)
    .set('Authorization', header)
    .send(body);
}

// --- The setting itself ---

test('a new company defaults to platform card processing', async () => {
  const { company } = await setupOwnerWithCompany();
  assert.equal(company.cardPaymentMode, 'platform');
});

test('an owner can switch to their own card terminal and back', async () => {
  const { header } = await setupOwnerWithCompany();

  const own = await setCardMode(header, 'own');
  assert.equal(own.status, 200);
  assert.equal(own.body.cardPaymentMode, 'own');

  const back = await setCardMode(header, 'platform');
  assert.equal(back.status, 200);
  assert.equal(back.body.cardPaymentMode, 'platform');
});

test('the setting persists and is visible on GET /api/companies/mine', async () => {
  const { header } = await setupOwnerWithCompany();
  await setCardMode(header, 'own');

  const res = await request(app).get('/api/companies/mine').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.cardPaymentMode, 'own');
});

test('an invalid card payment mode is rejected', async () => {
  const { header } = await setupOwnerWithCompany();
  const res = await setCardMode(header, 'stripe');
  assert.equal(res.status, 400);
});

test('setting the card payment mode with no active company is a 404', async () => {
  const userId = await insertUser();
  const res = await setCardMode(ownerHeaderFor(userId), 'own');
  assert.equal(res.status, 404);
});

test('the generic company PATCH cannot set the card payment mode', async () => {
  const { header } = await setupOwnerWithCompany();

  // Unknown keys are stripped, not rejected - the field simply has no effect
  // through this route, which is the point of the dedicated endpoint.
  const res = await request(app)
    .patch('/api/companies/mine')
    .set('Authorization', header)
    .send({ cardPaymentMode: 'own' });

  assert.equal(res.status, 200);
  assert.equal(res.body.cardPaymentMode, 'platform');
});

// --- Platform mode (the pre-existing behaviour) is unchanged ---

test('platform mode still routes card payments through the provider', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const order = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'card', amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.payments[0].method, 'card');
  assert.ok(res.body.payments[0].providerReference, 'platform mode must produce a provider reference');
});

// --- Own-terminal mode ---

test('own mode records a card payment with no provider reference', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'card', amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.balanceDue, 0);
  // The transaction type is still 'card' - only the provider call is skipped.
  assert.equal(res.body.payments[0].method, 'card');
  assert.equal(res.body.payments[0].providerReference, null);
  // Card semantics otherwise unchanged: no tendered/change concept.
  assert.equal(res.body.payments[0].amountTendered, null);
  assert.equal(res.body.payments[0].change, null);
});

test('own mode still rejects a card payment exceeding the balance', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'card', amount: 10.01 });

  assert.equal(res.status, 400);
});

test('own mode leaves cash payments completely unaffected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);

  const res = await pay(header, shopId, order.id, { method: 'cash', amountTendered: 20 });

  assert.equal(res.status, 201);
  assert.equal(res.body.payments[0].method, 'cash');
  assert.equal(res.body.payments[0].amount, 10);
  assert.equal(res.body.payments[0].change, 10);
});

test('own mode supports a cash+card split settling exactly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);

  await pay(header, shopId, order.id, { method: 'cash', amountTendered: 4 });
  const res = await pay(header, shopId, order.id, { method: 'card', amount: 6 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.payments.find((p) => p.method === 'card').providerReference, null);
});

test('own mode refunds a card payment without a provider reference', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);
  const paid = await pay(header, shopId, order.id, { method: 'card', amount: 10 });

  const res = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 10 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'refunded');
  assert.equal(res.body.netAmountPaid, 0);
  // Refunded on the shop's own terminal, out of band - we only record it.
  assert.equal(res.body.payments[0].refunds[0].providerReference, null);
});

// --- Switching modes mid-life: refunds key off the PAYMENT, not the live setting ---

test('a payment taken under platform mode is still provider-refunded after switching to own', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const order = await tenPoundOrder(header, shopId);

  // Charged through our provider...
  const paid = await pay(header, shopId, order.id, { method: 'card', amount: 10 });
  assert.ok(paid.body.payments[0].providerReference);

  // ...then the owner moves to their own terminal.
  await setCardMode(header, 'own');

  const res = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 10 });

  assert.equal(res.status, 201);
  // The money really is sitting with our provider, so it MUST still be
  // reversed there - reading the live setting would have wrongly skipped it.
  assert.ok(
    res.body.payments[0].refunds[0].providerReference,
    'a provider-charged payment must still be provider-refunded after a mode switch'
  );
});

test('a payment taken under own mode is not provider-refunded after switching to platform', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const order = await tenPoundOrder(header, shopId);

  // Taken on the shop's own terminal - we never charged anything.
  const paid = await pay(header, shopId, order.id, { method: 'card', amount: 10 });
  assert.equal(paid.body.payments[0].providerReference, null);

  // ...then the owner moves onto our processing.
  await setCardMode(header, 'platform');

  const res = await refund(header, shopId, order.id, paid.body.payments[0].id, { amount: 10 });

  assert.equal(res.status, 201);
  // We never took this money, so there is nothing for us to give back -
  // reading the live setting would have called the provider to reverse a
  // charge it never made.
  assert.equal(
    res.body.payments[0].refunds[0].providerReference,
    null,
    'a terminal-taken payment must never be provider-refunded after a mode switch'
  );
});

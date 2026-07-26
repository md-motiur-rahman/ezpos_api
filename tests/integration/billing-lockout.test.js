import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import Stripe from 'stripe';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import config from '../../src/config/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const stripe = new Stripe('sk_test_only_used_for_local_signing');

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

/** Owner + chain company with Stripe ids already in place, plus one shop. */
async function setupBilledCompany() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows: userRows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('grace-owner'), passwordHash]
  );
  const ownerUserId = userRows[0].id;
  const stripeCustomerId = `cus_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;

  const { rows: companyRows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone,
        business_type, stripe_customer_id, stripe_subscription_id, trial_ends_at)
     VALUES ($1, 'Grace Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567',
             'chain', $2, $3, now())
     RETURNING id`,
    [ownerUserId, stripeCustomerId, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  const companyId = companyRows[0].id;

  const { rows: shopRows } = await query(
    `INSERT INTO shops
       (company_id, name, address_line1, city, postcode, country, phone,
        vat_registered, stripe_subscription_item_id)
     VALUES ($1, 'Grace Shop', '1 St', 'London', 'E1 1AA', 'UK', '0201234567',
             true, $2)
     RETURNING id`,
    [companyId, `si_test_${crypto.randomUUID().slice(0, 8)}`]
  );

  const header = `Bearer ${signAccessToken({ id: ownerUserId, email: 'irrelevant@example.com' })}`;
  return { ownerUserId, companyId, shopId: shopRows[0].id, stripeCustomerId, header };
}

function postEvent(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.env.stripeWebhookSecret,
  });

  return request(app)
    .post('/api/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
}

function paymentFailedEvent(stripeCustomerId) {
  return {
    id: `evt_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    object: 'event',
    type: 'invoice.payment_failed',
    created: Math.floor(Date.now() / 1000),
    data: { object: { customer: stripeCustomerId, amount_due: 2999 } },
  };
}

function paymentSucceededEvent(stripeCustomerId) {
  return {
    id: `evt_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    object: 'event',
    type: 'invoice.payment_succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { customer: stripeCustomerId, amount_paid: 2999 } },
  };
}

async function billingState(companyId) {
  const { rows } = await query(
    `SELECT subscription_status, grace_period_ends_at FROM companies WHERE id = $1`,
    [companyId]
  );
  return rows[0];
}

/** Forces a company into a locked state without waiting 7 real days. */
async function expireGracePeriod(companyId) {
  await query(
    `UPDATE companies SET subscription_status = 'past_due', grace_period_ends_at = $1 WHERE id = $2`,
    [new Date(Date.now() - DAY_MS), companyId]
  );
}

const NEW_SHOP = {
  name: 'Another Shop',
  addressLine1: '5 New Street',
  city: 'London',
  postcode: 'E2 2BB',
  country: 'UK',
  phone: '02033334444',
  vatRegistered: true,
};

// --- Grace period state machine ---

test('the first payment failure starts a 7 day grace period', async () => {
  const { companyId, stripeCustomerId } = await setupBilledCompany();
  assert.equal((await billingState(companyId)).grace_period_ends_at, null);

  const res = await postEvent(paymentFailedEvent(stripeCustomerId));
  assert.equal(res.status, 200);

  const { grace_period_ends_at: endsAt } = await billingState(companyId);
  assert.ok(endsAt);
  const daysOut = (new Date(endsAt).getTime() - Date.now()) / DAY_MS;
  assert.ok(daysOut > 6.9 && daysOut < 7.1, `expected ~7 days, got ${daysOut}`);
});

test('a repeat payment failure does not extend an active grace period', async () => {
  const { companyId, stripeCustomerId } = await setupBilledCompany();

  await postEvent(paymentFailedEvent(stripeCustomerId));
  const first = (await billingState(companyId)).grace_period_ends_at;

  // Stripe retries the same failed invoice - the clock must not move, or
  // lockout would be pushed out indefinitely.
  await postEvent(paymentFailedEvent(stripeCustomerId));
  const second = (await billingState(companyId)).grace_period_ends_at;

  assert.deepEqual(second, first);
});

test('a successful payment clears the grace period', async () => {
  const { companyId, stripeCustomerId } = await setupBilledCompany();
  await postEvent(paymentFailedEvent(stripeCustomerId));
  assert.ok((await billingState(companyId)).grace_period_ends_at);

  const res = await postEvent(paymentSucceededEvent(stripeCustomerId));
  assert.equal(res.status, 200);

  assert.equal((await billingState(companyId)).grace_period_ends_at, null);
});

test('GET /api/companies/mine exposes gracePeriodEndsAt', async () => {
  const { companyId, stripeCustomerId, header } = await setupBilledCompany();

  const before = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(before.body.gracePeriodEndsAt, null);

  await postEvent(paymentFailedEvent(stripeCustomerId));

  const after = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.ok(after.body.gracePeriodEndsAt);
  assert.equal(companyId, after.body.id);
});

// --- Lockout gating ---

test('shop creation is allowed while the grace period is still running', async () => {
  const { stripeCustomerId, header } = await setupBilledCompany();
  await postEvent(paymentFailedEvent(stripeCustomerId));

  const res = await request(app).post('/api/shops').set('Authorization', header).send(NEW_SHOP);

  assert.equal(res.status, 201);
});

test('shop creation is blocked with 402 once the grace period has expired', async () => {
  const { companyId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app).post('/api/shops').set('Authorization', header).send(NEW_SHOP);

  assert.equal(res.status, 402);
  assert.match(res.body.error.message, /payment failed/i);
});

test('add-on activation is blocked with 402 once the grace period has expired', async () => {
  const { companyId, shopId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app)
    .post(`/api/shops/${shopId}/addons`)
    .set('Authorization', header)
    .send({ addonType: 'health_safety' });

  assert.equal(res.status, 402);
});

test('a canceled subscription is blocked even with a future grace period', async () => {
  const { companyId, header } = await setupBilledCompany();
  await query(
    `UPDATE companies SET subscription_status = 'canceled', grace_period_ends_at = $1 WHERE id = $2`,
    [new Date(Date.now() + DAY_MS), companyId]
  );

  const res = await request(app).post('/api/shops').set('Authorization', header).send(NEW_SHOP);

  assert.equal(res.status, 402);
});

// --- What stays available while locked (per the agreed behaviour) ---

test('a locked company can still sign in and read its company profile', async () => {
  const { companyId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app).get('/api/companies/mine').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.subscriptionStatus, 'past_due');
});

test('a locked company can still list its shops', async () => {
  const { companyId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app).get('/api/shops').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('a locked company can still close a shop, which reduces its bill', async () => {
  const { companyId, shopId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app).delete(`/api/shops/${shopId}`).set('Authorization', header);

  assert.equal(res.status, 200);
});

test('a locked company can still edit shop details', async () => {
  const { companyId, shopId, header } = await setupBilledCompany();
  await expireGracePeriod(companyId);

  const res = await request(app)
    .patch(`/api/shops/${shopId}`)
    .set('Authorization', header)
    .send({ city: 'Manchester' });

  assert.equal(res.status, 200);
  assert.equal(res.body.city, 'Manchester');
});
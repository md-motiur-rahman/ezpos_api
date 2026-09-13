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

const stripe = new Stripe('sk_test_only_used_for_local_signing');

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('pm-owner'), passwordHash]
  );
  return rows[0].id;
}

function authHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Payment Method Test Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

const VALID_SHOP = {
  name: 'Test Shop',
  addressLine1: '2 Market Street',
  city: 'London',
  postcode: 'E1 1AA',
  country: 'UK',
  phone: '02011112222',
  vatRegistered: true,
};

/** Owner + company. businessType null leaves the company without a Stripe customer. */
async function setupCompany(businessType = 'chain') {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  if (businessType) {
    await request(app)
      .post('/api/companies/mine/business-type')
      .set('Authorization', header)
      .send({ businessType });
  }
  const { rows } = await query(
    `SELECT id, stripe_customer_id FROM companies WHERE owner_user_id = $1`,
    [userId]
  );
  return { userId, header, companyId: rows[0].id, stripeCustomerId: rows[0].stripe_customer_id };
}

function checkoutCompletedEvent(stripeCustomerId, { mode = 'setup' } = {}) {
  return {
    id: `evt_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    object: 'event',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        customer: stripeCustomerId,
        mode,
        setup_intent: `seti_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`,
      },
    },
  };
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

async function hasPaymentMethod(companyId) {
  const { rows } = await query(`SELECT has_payment_method FROM companies WHERE id = $1`, [companyId]);
  return rows[0].has_payment_method;
}

// --- POST /api/companies/mine/billing/checkout-session ---

test('checkout-session requires auth', async () => {
  const res = await request(app).post('/api/companies/mine/billing/checkout-session');

  assert.equal(res.status, 401);
});

test('checkout-session returns a redirect url for a company with a Stripe customer', async () => {
  const { header } = await setupCompany('chain');

  const res = await request(app)
    .post('/api/companies/mine/billing/checkout-session')
    .set('Authorization', header);

  assert.equal(res.status, 201);
  assert.ok(res.body.url);
  assert.match(res.body.url, /^https:\/\/checkout\.stripe\.com\//);
});

test('checkout-session is rejected before a business type exists (no Stripe customer yet)', async () => {
  const { header } = await setupCompany(null);

  const res = await request(app)
    .post('/api/companies/mine/billing/checkout-session')
    .set('Authorization', header);

  assert.equal(res.status, 400);
});

test('checkout-session returns 404 when the caller has no company', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies/mine/billing/checkout-session')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 404);
});

// --- checkout.session.completed webhook ---

test('a completed setup checkout marks the company as having a payment method', async () => {
  const { companyId, stripeCustomerId } = await setupCompany('chain');
  assert.equal(await hasPaymentMethod(companyId), false); // nothing collected yet

  const res = await postEvent(checkoutCompletedEvent(stripeCustomerId));

  assert.equal(res.status, 200);
  assert.equal(await hasPaymentMethod(companyId), true);
});

test('a non-setup checkout session is ignored - this app never creates those', async () => {
  const { companyId, stripeCustomerId } = await setupCompany('chain');

  const res = await postEvent(checkoutCompletedEvent(stripeCustomerId, { mode: 'subscription' }));

  assert.equal(res.status, 200);
  assert.equal(await hasPaymentMethod(companyId), false);
});

test('GET /api/companies/mine exposes hasPaymentMethod so the dashboard can gate its form', async () => {
  const { header, stripeCustomerId } = await setupCompany('chain');

  const before = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(before.body.hasPaymentMethod, false);

  await postEvent(checkoutCompletedEvent(stripeCustomerId));

  const after = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(after.body.hasPaymentMethod, true);
});

// --- The gate on shop creation ---

test('creating the first shop is rejected with 402 when no card is on file', async () => {
  const { header } = await setupCompany('chain');

  const res = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  assert.equal(res.status, 402);
  assert.match(res.body.error.message, /payment method/i);
});

test('a rejected shop creation leaves no shop behind', async () => {
  const { header, companyId } = await setupCompany('chain');

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const { rows } = await query(
    `SELECT count(*)::int AS count FROM shops WHERE company_id = $1 AND deleted_at IS NULL`,
    [companyId]
  );
  assert.equal(rows[0].count, 0);
});

test('creating the first shop succeeds once checkout has completed', async () => {
  const { header, stripeCustomerId } = await setupCompany('chain');
  await postEvent(checkoutCompletedEvent(stripeCustomerId));

  const res = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  assert.equal(res.status, 201);
});

test('the trial is still granted when a card is collected up front', async () => {
  const { header, companyId, stripeCustomerId } = await setupCompany('chain');
  await postEvent(checkoutCompletedEvent(stripeCustomerId));

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  // Collecting a card must not have quietly removed the free trial.
  const { rows } = await query(`SELECT trial_ends_at FROM companies WHERE id = $1`, [companyId]);
  assert.ok(rows[0].trial_ends_at);
});

/**
 * The reported bug: closing the last shop clears stripe_subscription_id but
 * deliberately never clears trial_ends_at, so reopening creates a subscription
 * with trialDays: null - which Stripe refuses outright without a card. Before
 * this feature there was no way to ever attach one.
 */
test('a company that closed its last shop can reopen once a card is on file', async () => {
  const { header, companyId, stripeCustomerId } = await setupCompany('chain');
  await postEvent(checkoutCompletedEvent(stripeCustomerId));

  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app).delete(`/api/shops/${first.body.id}`).set('Authorization', header);

  const { rows } = await query(
    `SELECT stripe_subscription_id, trial_ends_at FROM companies WHERE id = $1`,
    [companyId]
  );
  assert.equal(rows[0].stripe_subscription_id, null); // subscription cancelled
  assert.ok(rows[0].trial_ends_at); // trial still marked used - no second free trial

  const reopened = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Reopened Shop' });

  assert.equal(reopened.status, 201);
});

test('reopening without a card is rejected with 402 rather than a raw Stripe error', async () => {
  const { header, companyId, stripeCustomerId } = await setupCompany('chain');
  await postEvent(checkoutCompletedEvent(stripeCustomerId));

  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  await request(app).delete(`/api/shops/${first.body.id}`).set('Authorization', header);

  // Simulate the card being gone (e.g. a company created before this feature).
  await query(`UPDATE companies SET has_payment_method = false WHERE id = $1`, [companyId]);

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Reopened Shop' });

  assert.equal(res.status, 402);
  assert.match(res.body.error.message, /payment method/i);
});

test('adding a SECOND shop needs no re-check - the subscription already exists', async () => {
  const { header, companyId, stripeCustomerId } = await setupCompany('chain');
  await postEvent(checkoutCompletedEvent(stripeCustomerId));
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  // Even with the flag cleared, the gate only guards NEW subscriptions.
  await query(`UPDATE companies SET has_payment_method = false WHERE id = $1`, [companyId]);

  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  assert.equal(res.status, 201);
});

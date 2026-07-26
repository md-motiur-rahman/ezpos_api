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

// Read from config rather than hardcoding, so these tests sign with whatever
// secret the app is actually verifying against - no way for the two to drift.
// Signatures are generated locally with real HMAC (no network call), so this
// exercises the genuine verification path rather than a stub.
const WEBHOOK_SECRET = config.env.stripeWebhookSecret;
const stripe = new Stripe('sk_test_only_used_for_local_signing');

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

/** A company with a known Stripe customer id, so events can be mapped to it. */
async function insertCompanyWithStripeCustomer() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows: userRows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('webhook-owner'), passwordHash]
  );
  const stripeCustomerId = `cus_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
  const { rows } = await query(
    `INSERT INTO companies
       (owner_user_id, name, address_line1, city, postcode, country, phone,
        business_type, stripe_customer_id, stripe_subscription_id)
     VALUES ($1, 'Webhook Co', '1 St', 'London', 'E1 1AA', 'UK', '0201234567',
             'single', $2, $3)
     RETURNING id`,
    [userRows[0].id, stripeCustomerId, `sub_test_${crypto.randomUUID().slice(0, 8)}`]
  );
  return { companyId: rows[0].id, stripeCustomerId, ownerUserId: userRows[0].id };
}

/** Posts an event with a genuinely valid Stripe signature. */
function postEvent(event) {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });

  return request(app)
    .post('/api/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(payload);
}

function buildEvent({ type, object, id }) {
  return {
    id: id ?? `evt_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

async function recordedEvents(companyId) {
  const { rows } = await query(
    `SELECT stripe_event_id, event_type, amount, status, occurred_at
     FROM stripe_webhook_events WHERE company_id = $1 ORDER BY created_at`,
    [companyId]
  );
  return rows;
}

async function subscriptionStatus(companyId) {
  const { rows } = await query(`SELECT subscription_status FROM companies WHERE id = $1`, [
    companyId,
  ]);
  return rows[0].subscription_status;
}

// --- Signature verification ---

test('POST /api/webhooks/stripe rejects a request with no signature header', async () => {
  const res = await request(app)
    .post('/api/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(buildEvent({ type: 'invoice.payment_succeeded', object: {} })));

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/stripe rejects a forged signature', async () => {
  const payload = JSON.stringify(buildEvent({ type: 'invoice.payment_succeeded', object: {} }));

  const res = await request(app)
    .post('/api/webhooks/stripe')
    .set('stripe-signature', 't=1,v1=totally_made_up_signature')
    .set('Content-Type', 'application/json')
    .send(payload);

  assert.equal(res.status, 400);
});

test('POST /api/webhooks/stripe rejects a payload tampered with after signing', async () => {
  const original = JSON.stringify(buildEvent({ type: 'invoice.payment_succeeded', object: {} }));
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: original,
    secret: WEBHOOK_SECRET,
  });

  const res = await request(app)
    .post('/api/webhooks/stripe')
    .set('stripe-signature', signature)
    .set('Content-Type', 'application/json')
    .send(original.replace('"object":"event"', '"object":"tampered"'));

  assert.equal(res.status, 400);
});

// --- invoice.payment_succeeded / failed ---

test('invoice.payment_succeeded is recorded with the paid amount', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();

  const res = await postEvent(
    buildEvent({
      type: 'invoice.payment_succeeded',
      object: { customer: stripeCustomerId, amount_paid: 2999 },
    })
  );
  assert.equal(res.status, 200);

  const events = await recordedEvents(companyId);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'invoice.payment_succeeded');
  assert.equal(events[0].amount, 2999);
  assert.equal(events[0].status, 'succeeded');
  assert.ok(events[0].occurred_at);
});

test('invoice.payment_failed is recorded with the amount due', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();

  const res = await postEvent(
    buildEvent({
      type: 'invoice.payment_failed',
      object: { customer: stripeCustomerId, amount_due: 4500 },
    })
  );
  assert.equal(res.status, 200);

  const events = await recordedEvents(companyId);
  assert.equal(events[0].amount, 4500);
  assert.equal(events[0].status, 'failed');
});

// --- Idempotency ---

test('redelivering the same event does not record it twice', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();
  const event = buildEvent({
    type: 'invoice.payment_succeeded',
    object: { customer: stripeCustomerId, amount_paid: 1000 },
  });

  const first = await postEvent(event);
  const second = await postEvent(event); // same event id - Stripe retry

  assert.equal(first.status, 200);
  assert.equal(second.status, 200); // still acknowledged, so Stripe stops retrying
  assert.equal((await recordedEvents(companyId)).length, 1);
});

// --- Subscription status sync ---

test('customer.subscription.updated syncs subscription_status', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();
  assert.equal(await subscriptionStatus(companyId), null);

  const res = await postEvent(
    buildEvent({
      type: 'customer.subscription.updated',
      object: { customer: stripeCustomerId, status: 'past_due' },
    })
  );
  assert.equal(res.status, 200);

  assert.equal(await subscriptionStatus(companyId), 'past_due');
});

test('customer.subscription.deleted sets subscription_status to canceled', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();

  const res = await postEvent(
    buildEvent({
      type: 'customer.subscription.deleted',
      object: { customer: stripeCustomerId, status: 'canceled' },
    })
  );
  assert.equal(res.status, 200);

  assert.equal(await subscriptionStatus(companyId), 'canceled');
});

test('GET /api/companies/mine exposes subscriptionStatus once a webhook has set it', async () => {
  const { ownerUserId, stripeCustomerId } = await insertCompanyWithStripeCustomer();
  const header = `Bearer ${signAccessToken({ id: ownerUserId, email: 'irrelevant@example.com' })}`;

  const before = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(before.body.subscriptionStatus, null);

  await postEvent(
    buildEvent({
      type: 'customer.subscription.updated',
      object: { customer: stripeCustomerId, status: 'active' },
    })
  );

  const after = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(after.body.subscriptionStatus, 'active');
});

// --- Unhandled / unmatched events ---

test('an event type we do not handle is acknowledged but not recorded', async () => {
  const { companyId, stripeCustomerId } = await insertCompanyWithStripeCustomer();

  const res = await postEvent(
    buildEvent({
      type: 'customer.updated',
      object: { customer: stripeCustomerId },
    })
  );

  assert.equal(res.status, 200);
  assert.equal((await recordedEvents(companyId)).length, 0);
});

test('an event for an unknown Stripe customer is recorded without a company and does not error', async () => {
  const res = await postEvent(
    buildEvent({
      type: 'invoice.payment_succeeded',
      object: { customer: 'cus_test_does_not_exist_here', amount_paid: 500 },
    })
  );

  assert.equal(res.status, 200);

  const { rows } = await query(
    `SELECT company_id, amount FROM stripe_webhook_events WHERE company_id IS NULL AND amount = 500`
  );
  assert.ok(rows.length >= 1);
});
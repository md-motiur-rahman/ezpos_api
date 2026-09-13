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
 * Per-shop, daily-resetting order numbers.
 *
 * The property that actually matters is UNIQUENESS UNDER CONCURRENCY: two
 * tills ringing up at the same instant must never be handed the same number.
 * That is delegated to one atomic INSERT ... ON CONFLICT DO UPDATE statement
 * (see allocateOrderNumber), not to a SELECT max()+1, because this project
 * has no transaction wrapper to make read-then-write safe.
 */

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('order-number-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function createShop(header, name, phone) {
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name,
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone,
      vatRegistered: true,
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
      name: `Order Number Test Ltd ${crypto.randomUUID()}`,
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
  const shopId = await createShop(header, 'Test Shop', '02011112222');
  return { header, shopId };
}

async function createMenuItem(header, name, price = 10) {
  const catRes = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: `Cat ${crypto.randomUUID()}` });
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: catRes.body.id, name, price });
  return res.body.id;
}

function createOrder(header, shopId, itemId) {
  return request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: itemId, quantity: 1 }] });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// --- Basic allocation ---

test('orders are numbered from 1 within a shop and increment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');

  const first = await createOrder(header, shopId, itemId);
  const second = await createOrder(header, shopId, itemId);
  const third = await createOrder(header, shopId, itemId);

  assert.equal(first.status, 201);
  assert.equal(first.body.orderNumber, 1);
  assert.equal(second.body.orderNumber, 2);
  assert.equal(third.body.orderNumber, 3);
  assert.equal(first.body.orderDate, todayUtc());
});

test('each shop keeps its own independent sequence', async () => {
  const { header, shopId: shopA } = await setupOwnerWithShop();
  const shopB = await createShop(header, 'Second Shop', '02011113333');
  const itemId = await createMenuItem(header, 'Burger');

  const a1 = await createOrder(header, shopA, itemId);
  const a2 = await createOrder(header, shopA, itemId);
  const b1 = await createOrder(header, shopB, itemId);

  assert.equal(a1.body.orderNumber, 1);
  assert.equal(a2.body.orderNumber, 2);
  assert.equal(b1.body.orderNumber, 1, "shop B's sequence must not continue shop A's");
});

test('the order number is visible on the list and detail reads', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');
  const created = await createOrder(header, shopId, itemId);

  const detail = await request(app)
    .get(`/api/shops/${shopId}/orders/${created.body.id}`)
    .set('Authorization', header);
  assert.equal(detail.body.orderNumber, 1);
  assert.equal(detail.body.orderDate, todayUtc());

  const list = await request(app)
    .get(`/api/shops/${shopId}/orders`)
    .set('Authorization', header);
  assert.equal(list.body[0].orderNumber, 1);
  assert.equal(list.body[0].orderDate, todayUtc());
});

// --- The property that actually matters ---

test('concurrent orders never receive the same number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');

  // Fired together, not awaited in sequence - this is the two-tills case the
  // atomic allocation exists for. A SELECT max()+1 collides here (verified:
  // swapping the allocation for one fails exactly this test and no other).
  //
  // 8, deliberately not more: the pg pool's default max is 10, and this file
  // runs alongside ~70 others under `node --test`. Asking for more concurrent
  // requests than the pool holds would queue them, and with
  // connectionTimeoutMillis now set (10s) a queued acquisition under heavy
  // full-suite load fails outright rather than merely waiting. 8 simultaneous
  // in-flight requests all get a connection immediately and still genuinely
  // race on the same counter row, which is the whole property under test.
  const CONCURRENT = 8;
  const responses = await Promise.all(
    Array.from({ length: CONCURRENT }, () => createOrder(header, shopId, itemId))
  );

  const numbers = responses.map((r) => r.body.orderNumber);
  assert.equal(responses.every((r) => r.status === 201), true);
  assert.equal(
    new Set(numbers).size,
    CONCURRENT,
    `duplicate order numbers issued: ${numbers.join(',')}`
  );
  assert.deepEqual(
    [...numbers].sort((a, b) => a - b),
    Array.from({ length: CONCURRENT }, (_, i) => i + 1),
    'numbers must be contiguous with no gaps'
  );
});

// --- Daily reset, exercised through 9.7's occurredAt ---

test('a new day starts its numbering again at 1', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');

  const sync = (clientOrderId, occurredAt) =>
    request(app)
      .post(`/api/shops/${shopId}/orders/sync`)
      .set('Authorization', header)
      .send({
        clientOrderId,
        occurredAt,
        type: 'takeaway',
        items: [{ menuItemId: itemId, quantity: 1, unitPrice: 10 }],
        payment: { method: 'cash', amountTendered: 10 },
      });

  const dayOne = await sync(crypto.randomUUID(), '2030-03-01T18:00:00.000Z');
  const dayOneAgain = await sync(crypto.randomUUID(), '2030-03-01T19:00:00.000Z');
  const dayTwo = await sync(crypto.randomUUID(), '2030-03-02T18:00:00.000Z');

  assert.equal(dayOne.body.orderNumber, 1);
  assert.equal(dayOneAgain.body.orderNumber, 2);
  assert.equal(dayTwo.body.orderNumber, 1, 'a new day restarts the sequence');
  // Numbered against the day the sale HAPPENED, not the day it synced.
  assert.equal(dayOne.body.orderDate, '2030-03-01');
  assert.equal(dayTwo.body.orderDate, '2030-03-02');
});

test('an idempotent replay does not burn an order number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');
  const clientOrderId = crypto.randomUUID();
  const body = {
    clientOrderId,
    occurredAt: '2030-04-01T18:00:00.000Z',
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1, unitPrice: 10 }],
    payment: { method: 'cash', amountTendered: 10 },
  };
  const sync = (payload) =>
    request(app)
      .post(`/api/shops/${shopId}/orders/sync`)
      .set('Authorization', header)
      .send(payload);

  const first = await sync(body);
  assert.equal(first.status, 201);
  assert.equal(first.body.orderNumber, 1);

  // A till with flaky connectivity re-sends the same queued sale.
  const replayA = await sync(body);
  const replayB = await sync(body);
  assert.equal(replayA.status, 200);
  assert.equal(replayB.status, 200);
  assert.equal(replayA.body.orderNumber, 1, 'a replay returns the ORIGINAL number');
  assert.equal(replayB.body.orderNumber, 1);

  // The next genuinely new sale that day must be 2, not 4 - proving the two
  // replays consumed nothing from the counter.
  const next = await sync({ ...body, clientOrderId: crypto.randomUUID() });
  assert.equal(next.body.orderNumber, 2, 'replays must not tear gaps in the sequence');
});

// --- Pre-existing orders ---

test('an order created before numbering shipped reads back null, not a fabricated number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const itemId = await createMenuItem(header, 'Burger');
  const created = await createOrder(header, shopId, itemId);

  // Simulate a legacy row: null out what the migration left nullable.
  await query(`UPDATE orders SET order_number = NULL, order_date = NULL WHERE id = $1`, [
    created.body.id,
  ]);

  const detail = await request(app)
    .get(`/api/shops/${shopId}/orders/${created.body.id}`)
    .set('Authorization', header);

  assert.equal(detail.status, 200);
  assert.equal(detail.body.orderNumber, null);
  assert.equal(detail.body.orderDate, null);
});

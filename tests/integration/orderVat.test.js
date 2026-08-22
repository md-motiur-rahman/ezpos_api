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
    [uniqueEmail('order-vat-owner'), passwordHash]
  );
  return rows[0].id;
}

function ownerHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function createShop(header, overrides = {}) {
  const res = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Test Shop',
      addressLine1: '2 Market St',
      city: 'London',
      postcode: 'E1 1AA',
      country: 'UK',
      phone: '02011112222',
      vatRegistered: false,
      ...overrides,
    });
  return res.body.id;
}

async function setupOwnerWithCompany() {
  const userId = await insertUser();
  const header = ownerHeaderFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: `Order VAT Test Ltd ${crypto.randomUUID()}`,
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
  return { header };
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
  return request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send(body);
}

function getOrder(header, shopId, orderId) {
  return request(app)
    .get(`/api/shops/${shopId}/orders/${orderId}`)
    .set('Authorization', header);
}

function updateShop(header, shopId, data) {
  return request(app)
    .patch(`/api/shops/${shopId}`)
    .set('Authorization', header)
    .send(data);
}

async function countOrders(shopId) {
  const { rows } = await query(`SELECT count(*)::int AS c FROM orders WHERE shop_id = $1`, [shopId]);
  return rows[0].c;
}

/** Directly inserts an order the way one would have looked BEFORE 9.8 shipped - no vat_rate at all. */
async function insertLegacyOrder(shopId, actorId) {
  const { rows } = await query(
    `INSERT INTO orders (shop_id, type, created_by_actor_type, created_by_actor_id)
     VALUES ($1, 'takeaway', 'owner', $2)
     RETURNING id`,
    [shopId, actorId]
  );
  return rows[0].id;
}

// --- Baseline: a non-VAT-registered shop ---

test('an order from a non-VAT-registered shop reports 0% VAT and vatExclusiveAmount equal to total', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: false });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.total, 10);
  assert.equal(res.body.vatRate, 0);
  assert.equal(res.body.vatExclusiveAmount, 10);
  assert.equal(res.body.vatAmount, 0);
});

// --- A VAT-registered shop with a configured rate ---

test('an order from a VAT-registered shop decomposes the total at the configured rate', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.total, 10, 'the customer-facing total is UNCHANGED - VAT-inclusive');
  assert.equal(res.body.vatRate, 20);
  assert.equal(res.body.vatExclusiveAmount, 8.33);
  assert.equal(res.body.vatAmount, 1.67);
  // The real invariant: the decomposition always reconciles to the total exactly.
  assert.equal(
    Number((res.body.vatExclusiveAmount + res.body.vatAmount).toFixed(2)),
    res.body.total
  );
});

test('a repeating-decimal VAT split still reconciles to the total exactly', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  // £7.99 / 1.2 = 6.6583333... - a genuine repeating decimal.
  const itemId = await createMenuItem(header, categoryId, 'Item', 7.99);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.vatExclusiveAmount, 6.66);
  assert.equal(res.body.vatAmount, 1.33);
  assert.equal(
    Number((res.body.vatExclusiveAmount + res.body.vatAmount).toFixed(2)),
    7.99
  );
});

// --- Registered but no rate configured (a real gap this project's schema allows) ---

test('a VAT-registered shop with no configured rate is treated as 0%, not blocked', async () => {
  const { header } = await setupOwnerWithCompany();
  // vatRegistered: true, defaultVatRate deliberately omitted.
  const shopId = await createShop(header, { vatRegistered: true });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201, 'order creation must not be blocked by the shop misconfiguration');
  assert.equal(res.body.vatRate, 0);
  assert.equal(res.body.vatExclusiveAmount, 10);
  assert.equal(res.body.vatAmount, 0);
});

// --- The core of 9.8: the rate is a SNAPSHOT, not a live lookup ---

test('an order keeps its original VAT rate after the shop rate changes later', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  assert.equal(created.body.vatRate, 20);

  // The owner changes the shop's VAT rate AFTER the order was placed.
  const update = await updateShop(header, shopId, { defaultVatRate: 5 });
  assert.equal(update.status, 200);
  assert.equal(update.body.defaultVatRate, 5);

  // Re-fetching the SAME order must show its ORIGINAL rate, unchanged.
  const refetched = await getOrder(header, shopId, created.body.id);
  assert.equal(refetched.status, 200);
  assert.equal(refetched.body.vatRate, 20, 'a historical order must not silently re-rate itself');
  assert.equal(refetched.body.vatExclusiveAmount, 8.33);
  assert.equal(refetched.body.vatAmount, 1.67);
});

test('an order created AFTER a shop rate change picks up the NEW rate', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  await updateShop(header, shopId, { defaultVatRate: 5 });

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.vatRate, 5, 'a NEW order snapshots whatever rate is current at ITS creation');
  assert.equal(res.body.vatExclusiveAmount, 9.52);
  assert.equal(res.body.vatAmount, 0.48);
});

test('turning off VAT registration after an order is placed does not retroactively remove its VAT', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  assert.equal(created.body.vatRate, 20);

  const update = await updateShop(header, shopId, { vatRegistered: false });
  assert.equal(update.status, 200);

  const refetched = await getOrder(header, shopId, created.body.id);
  assert.equal(refetched.body.vatRate, 20, 'the historical snapshot is unaffected by de-registration');

  // But a brand-new order at the now-unregistered shop correctly gets 0%.
  const newOrder = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  assert.equal(newOrder.body.vatRate, 0);
});

// --- A pre-9.8 order: honest null, not a fabricated 0% ---

test('a legacy order with no vat_rate at all reports null, not a fabricated 0%', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const ownerRes = await request(app).get('/api/me').set('Authorization', header);
  const legacyOrderId = await insertLegacyOrder(shopId, ownerRes.body.id);

  const res = await getOrder(header, shopId, legacyOrderId);

  assert.equal(res.status, 200);
  assert.equal(res.body.vatRate, null);
  assert.equal(res.body.vatExclusiveAmount, null);
  assert.equal(res.body.vatAmount, null);
  // Every other field a legacy order has must still read back correctly -
  // 9.8 must not have broken anything about reading a plain, minimal order.
  assert.equal(res.body.total, 0, 'a legacy order with zero items has a zero total');
});

// --- Interaction with 9.3 discounts and 9.4 voids: VAT decomposes the FINAL total ---

test('VAT is calculated on the post-discount total, not the pre-discount subtotal', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  const orderId = created.body.id;

  const discounted = await request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'percentage', discountValue: 50 });

  assert.equal(discounted.status, 200);
  assert.equal(discounted.body.total, 5, 'a 50% order discount halves the total');
  assert.equal(discounted.body.vatRate, 20);
  assert.equal(discounted.body.vatExclusiveAmount, 4.17);
  assert.equal(discounted.body.vatAmount, 0.83);
  assert.equal(
    Number((discounted.body.vatExclusiveAmount + discounted.body.vatAmount).toFixed(2)),
    5
  );
});

test('VAT reflects the total AFTER a voided item is excluded', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 2);

  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const orderId = created.body.id;
  const friesItemId = created.body.items.find((i) => i.menuItemId === friesId).id;

  const voided = await request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/items/${friesItemId}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  assert.equal(voided.status, 200);
  assert.equal(voided.body.total, 10, 'the voided £2 fries are excluded from the total');
  assert.equal(voided.body.vatExclusiveAmount, 8.33);
  assert.equal(voided.body.vatAmount, 1.67);
});

test('cancelling an order does not zero out its VAT breakdown', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const cancelled = await request(app)
    .post(`/api/shops/${shopId}/orders/${created.body.id}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(cancelled.body.total, 10, 'cancellation does not zero the record of what the order contained');
  assert.equal(cancelled.body.vatRate, 20);
  assert.equal(cancelled.body.vatExclusiveAmount, 8.33);
  assert.equal(cancelled.body.vatAmount, 1.67);
});

// --- Zero-rated edge case: no division-by-zero, no weirdness ---

test('an explicit 0% configured rate behaves identically to a non-registered shop', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 0 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.vatRate, 0);
  assert.equal(res.body.vatExclusiveAmount, 10);
  assert.equal(res.body.vatAmount, 0);
});

// --- Offline sync (9.7) also snapshots the rate ---

test('a synced offline order also snapshots the shop VAT rate at sync time', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const res = await request(app)
    .post(`/api/shops/${shopId}/orders/sync`)
    .set('Authorization', header)
    .send({
      clientOrderId: `till-1-${crypto.randomUUID()}`,
      occurredAt: '2026-08-20T18:30:00.000Z',
      type: 'takeaway',
      items: [{ menuItemId: burgerId, quantity: 1, unitPrice: 10 }],
      payment: { method: 'cash', amountTendered: 10 },
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.vatRate, 20);
  assert.equal(res.body.vatExclusiveAmount, 8.33);
  assert.equal(res.body.vatAmount, 1.67);
});

test('replaying the same offline sync returns the identically-snapshotted VAT, unaffected by a later rate change', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const body = {
    clientOrderId: `till-1-${crypto.randomUUID()}`,
    occurredAt: '2026-08-20T18:30:00.000Z',
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1, unitPrice: 10 }],
    payment: { method: 'cash', amountTendered: 10 },
  };

  const first = await request(app)
    .post(`/api/shops/${shopId}/orders/sync`)
    .set('Authorization', header)
    .send(body);
  assert.equal(first.status, 201);
  assert.equal(first.body.vatRate, 20);

  await updateShop(header, shopId, { defaultVatRate: 5 });

  const replay = await request(app)
    .post(`/api/shops/${shopId}/orders/sync`)
    .set('Authorization', header)
    .send(body);

  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.vatRate, 20, 'a replay returns the ORIGINAL stored order, not a re-synced one');
  assert.equal(await countOrders(shopId), 1);
});

// --- Permission: no new gate, still ACCESS_TILL ---

test('a Server (ACCESS_TILL by default) sees the VAT breakdown like any other order field', async () => {
  const { header } = await setupOwnerWithCompany();
  const shopId = await createShop(header, { vatRegistered: true, defaultVatRate: 20 });
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await createOrder(serverHeader, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.vatRate, 20);
  assert.equal(res.body.vatExclusiveAmount, 8.33);
});

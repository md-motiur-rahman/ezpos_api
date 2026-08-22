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
    [uniqueEmail('order-sync-owner'), passwordHash]
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
      name: `Order Sync Test Ltd ${crypto.randomUUID()}`,
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

async function createVariant(header, itemId, name, price) {
  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${itemId}/variants`)
    .set('Authorization', header)
    .send({ name, price });
  return res.body.id;
}

async function createModifierGroup(header, name, minSelections, maxSelections) {
  const res = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name, minSelections, maxSelections });
  return res.body.id;
}

async function createModifierOption(header, groupId, name, priceDelta) {
  const res = await request(app)
    .post(`/api/companies/mine/modifier-groups/${groupId}/options`)
    .set('Authorization', header)
    .send({ name, priceDelta });
  return res.body.id;
}

async function attachModifierGroupToItem(header, itemId, groupId) {
  await request(app)
    .post(`/api/companies/mine/menu-items/${itemId}/modifier-groups/${groupId}`)
    .set('Authorization', header);
}

async function setItemOverride(header, shopId, menuItemId, data) {
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${menuItemId}`)
    .set('Authorization', header)
    .send(data);
}

function setCardMode(header, cardPaymentMode) {
  return request(app)
    .post('/api/companies/mine/card-payment-mode')
    .set('Authorization', header)
    .send({ cardPaymentMode });
}

function sync(header, shopId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders/sync`)
    .set('Authorization', header)
    .send(body);
}

async function countOrders(shopId) {
  const { rows } = await query(`SELECT count(*)::int AS c FROM orders WHERE shop_id = $1`, [shopId]);
  return rows[0].c;
}

async function countPayments(shopId) {
  const { rows } = await query(
    `SELECT count(*)::int AS c FROM order_payments p
     JOIN orders o ON o.id = p.order_id WHERE o.shop_id = $1`,
    [shopId]
  );
  return rows[0].c;
}

const OCCURRED_AT = '2026-08-20T18:30:00.000Z';

/** A £10 burger on the master menu - the baseline most cases below build on. */
async function tenPoundBurger(header) {
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  return { categoryId, burgerId };
}

/** The canonical queued payload: one £10 burger, paid with a £10 note. */
function cashSyncBody(burgerId, overrides = {}) {
  return {
    clientOrderId: `till-1-${crypto.randomUUID()}`,
    occurredAt: OCCURRED_AT,
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1, unitPrice: 10 }],
    payment: { method: 'cash', amountTendered: 10 },
    ...overrides,
  };
}

// --- Baseline: 9.7 is additive, online orders are untouched ---

test('an order created through the normal online flow reports null sync fields', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const res = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: burgerId, quantity: 1 }] });

  assert.equal(res.status, 201);
  assert.equal(res.body.clientOrderId, null);
  assert.equal(res.body.occurredAt, null);
  // Everything 9.1-9.6 returned is unchanged for an online order.
  assert.equal(res.body.status, 'open');
  assert.equal(res.body.subtotal, 10);
  assert.equal(res.body.balanceDue, 10);
});

// --- First sync ---

test('a queued cash sale syncs, creating a paid order with the till own id and time', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const res = await sync(header, shopId, body);

  assert.equal(res.status, 201);
  assert.equal(res.body.clientOrderId, body.clientOrderId);
  assert.equal(new Date(res.body.occurredAt).toISOString(), OCCURRED_AT);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.subtotal, 10);
  assert.equal(res.body.total, 10);
  assert.equal(res.body.amountPaid, 10);
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].unitPrice, 10);
  assert.equal(res.body.payments.length, 1);
  assert.equal(res.body.payments[0].method, 'cash');
  assert.equal(res.body.payments[0].change, 0);
  // Cash never involves our provider.
  assert.equal(res.body.payments[0].providerReference, null);
});

test('occurredAt is the sale time on the device, distinct from and earlier than createdAt', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(header, shopId, cashSyncBody(burgerId));

  assert.equal(res.status, 201);
  const occurred = new Date(res.body.occurredAt).getTime();
  const created = new Date(res.body.createdAt).getTime();
  assert.ok(occurred < created, 'the offline sale must predate the moment the server recorded it');
});

test('a synced order appears in the order list carrying its client order id', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);
  await sync(header, shopId, body);

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].clientOrderId, body.clientOrderId);
  assert.equal(new Date(res.body[0].occurredAt).toISOString(), OCCURRED_AT);
});

// --- Idempotency: the core of 9.7 ---

test('replaying the identical payload returns the original order with 200 and writes nothing new', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const first = await sync(header, shopId, body);
  assert.equal(first.status, 201);

  const replay = await sync(header, shopId, body);
  assert.equal(replay.status, 200, 'a replay is not a creation');
  assert.equal(replay.body.id, first.body.id, 'the SAME order comes back');

  // The whole point: one queued sale can never become two orders or two
  // payments, however many times the till re-sends it.
  assert.equal(await countOrders(shopId), 1);
  assert.equal(await countPayments(shopId), 1);
  assert.equal(replay.body.amountPaid, 10);
});

test('replaying many times stays at exactly one order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await sync(header, shopId, body);
    statuses.push(res.status);
  }

  assert.deepEqual(statuses, [201, 200, 200, 200, 200]);
  assert.equal(await countOrders(shopId), 1);
  assert.equal(await countPayments(shopId), 1);
});

test('the same clientOrderId with a DIFFERENT payload is rejected 409 and writes nothing', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const first = await sync(header, shopId, body);
  assert.equal(first.status, 201);

  // Same key, but two burgers rather than one - a reused key, i.e. a real
  // client bug. Silently returning the original would leave this second
  // sale unsynced forever with nothing to indicate it.
  const collision = await sync(header, shopId, {
    ...body,
    items: [{ menuItemId: burgerId, quantity: 2, unitPrice: 10 }],
    payment: { method: 'cash', amountTendered: 20 },
  });

  assert.equal(collision.status, 409);
  assert.match(collision.body.error.message, /already been used/i);
  assert.equal(await countOrders(shopId), 1, 'the collision must not create a second order');
  assert.equal(await countPayments(shopId), 1);
});

test('a replay whose money is formatted differently still counts as the same payload', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const first = await sync(header, shopId, body);
  assert.equal(first.status, 201);

  // 10 vs 10.00 is the same amount of money. The canonicalizer normalizes
  // through roundMoney precisely so a client that reformats its own queue
  // entry between retries doesn't get a spurious 409 on the same sale.
  const replay = await sync(header, shopId, {
    ...body,
    items: [{ menuItemId: burgerId, quantity: 1, unitPrice: 10.0 }],
    payment: { method: 'cash', amountTendered: 10.0 },
  });

  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(await countOrders(shopId), 1);
});

test('a replay whose occurredAt is written with a different but equal ISO form is still the same payload', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);

  const first = await sync(header, shopId, body);
  assert.equal(first.status, 201);

  // '...T18:30:00.000Z' and '...T19:30:00+01:00' are the same instant.
  const replay = await sync(header, shopId, { ...body, occurredAt: '2026-08-20T19:30:00+01:00' });

  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
});

test('the same clientOrderId in two different shops creates an order in each', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const otherShopId = await createShop(header, 'Second Shop');
  const { burgerId } = await tenPoundBurger(header);

  // Two tills generate their own ids independently and can legitimately
  // collide across shops - the uniqueness is deliberately per-shop.
  const sharedKey = `till-A-${crypto.randomUUID()}`;
  const first = await sync(header, shopId, cashSyncBody(burgerId, { clientOrderId: sharedKey }));
  const second = await sync(header, otherShopId, cashSyncBody(burgerId, { clientOrderId: sharedKey }));

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.id, second.body.id);
  assert.equal(await countOrders(shopId), 1);
  assert.equal(await countOrders(otherShopId), 1);
});

// --- Cash handling ---

test('an over-tendered queued cash sale credits only what was owed and derives the change', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { payment: { method: 'cash', amountTendered: 20 } })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.amountPaid, 10, 'only the £10 owed is credited');
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.payments[0].amountTendered, 20);
  assert.equal(res.body.payments[0].change, 10);
});

test('a queued cash sale that under-pays syncs as partially_paid with the balance still due', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { payment: { method: 'cash', amountTendered: 4 } })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'partially_paid');
  assert.equal(res.body.amountPaid, 4);
  assert.equal(res.body.balanceDue, 6);
});

// --- Card: only a shop's own terminal can have taken one offline ---

test("a queued card sale syncs for a company on its OWN terminal, with no provider reference", async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { payment: { method: 'card', amount: 10 } })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.payments[0].method, 'card');
  assert.equal(res.body.payments[0].amount, 10);
  // The money was taken out of band on their machine - inventing a
  // reference would claim a transaction we never made.
  assert.equal(res.body.payments[0].providerReference, null);
  assert.equal(res.body.payments[0].amountTendered, null);
  assert.equal(res.body.payments[0].change, null);
});

test('a queued card sale is REJECTED for a company on platform processing, writing nothing', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  // 'platform' is the default; stated explicitly for clarity.
  await setCardMode(header, 'platform');
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { payment: { method: 'card', amount: 10 } })
  );

  // Our provider must be reached live to authorise a card, so a queued
  // platform card sale could not have legitimately happened - accepting it
  // would record money as taken that nothing ever charged.
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /cannot be taken offline/i);
  assert.equal(await countOrders(shopId), 0);
  assert.equal(await countPayments(shopId), 0);
});

test('cash still syncs normally for a company on platform card processing', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'platform');
  const { burgerId } = await tenPoundBurger(header);

  // The platform-card rejection above must not leak into the cash path.
  const res = await sync(header, shopId, cashSyncBody(burgerId));

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
});

test('a queued card amount above the order total is rejected BEFORE anything is written', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId, { payment: { method: 'card', amount: 25 } });

  const res = await sync(header, shopId, body);

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /cannot exceed the order total/i);
  // Critical: nothing may be written on a rejection. A half-written order
  // would permanently burn this clientOrderId - every honest retry would
  // then match the unique index and never sync the real sale.
  assert.equal(await countOrders(shopId), 0);
  assert.equal(await countPayments(shopId), 0);

  // Proving exactly that: the corrected retry of the SAME key now works.
  const retry = await sync(header, shopId, { ...body, payment: { method: 'card', amount: 10 } });
  assert.equal(retry.status, 201);
  assert.equal(retry.body.status, 'paid');
});

// --- Trusting the client's snapshotted prices ---

test('the price the customer was actually charged is stored, not the current menu price', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  // The till sold it at £8.50 from its cached menu; the live menu now says
  // £10. The sale already completed at £8.50 and the cash is in the drawer,
  // so re-pricing it would make the record disagree with the receipt.
  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, {
      items: [{ menuItemId: burgerId, quantity: 1, unitPrice: 8.5 }],
      payment: { method: 'cash', amountTendered: 8.5 },
    })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].unitPrice, 8.5);
  assert.equal(res.body.subtotal, 8.5);
  assert.equal(res.body.total, 8.5);
  assert.equal(res.body.amountPaid, 8.5);
  assert.equal(res.body.balanceDue, 0);
});

test('an item disabled since the offline sale still syncs', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  // 86'd after the sale happened.
  await setItemOverride(header, shopId, burgerId, { isEnabled: false });

  const res = await sync(header, shopId, cashSyncBody(burgerId));

  // Rejecting would discard a sale that really happened - strictly worse
  // than recording a sale of something now unavailable.
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'paid');
});

test('a required modifier group is not re-enforced against a queued sale', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const groupId = await createModifierGroup(header, 'Choose a bun', 1, 1);
  await createModifierOption(header, groupId, 'Brioche', 0);
  await attachModifierGroupToItem(header, burgerId, groupId);

  // The online flow (9.1) rejects this outright - min/max is enforced there.
  const online = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send({ type: 'takeaway', items: [{ menuItemId: burgerId, quantity: 1 }] });
  assert.equal(online.status, 400, 'the ONLINE path still enforces min/max');

  // The offline till already enforced it at sale time against its cached
  // menu; re-enforcing against a group configured since would reject a
  // legitimately-completed sale.
  const res = await sync(header, shopId, cashSyncBody(burgerId));
  assert.equal(res.status, 201);
});

test('a queued sale with variants and modifiers totals from the client prices', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const largeId = await createVariant(header, burgerId, 'Large', 13);
  const groupId = await createModifierGroup(header, 'Extras', 0, 3);
  const cheeseId = await createModifierOption(header, groupId, 'Extra cheese', 1.25);
  await attachModifierGroupToItem(header, burgerId, groupId);

  // Variant price is absolute; modifier deltas are additive.
  // (12.50 + 1.10) * 2 = 27.20
  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, {
      items: [
        {
          menuItemId: burgerId,
          variantId: largeId,
          quantity: 2,
          unitPrice: 12.5,
          modifiers: [{ modifierOptionId: cheeseId, priceDelta: 1.1 }],
        },
      ],
      payment: { method: 'cash', amountTendered: 27.2 },
    })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].unitPrice, 12.5, 'the client variant price, not the live 13');
  assert.equal(res.body.items[0].modifiers[0].priceDelta, 1.1, 'the client delta, not the live 1.25');
  assert.equal(res.body.items[0].lineTotal, 27.2);
  assert.equal(res.body.subtotal, 27.2);
  // The total the payment was settled against (computed pre-insert) must
  // equal the total derived from the stored rows - one calculation, two
  // paths, asserted rather than assumed.
  assert.equal(res.body.total, 27.2);
  assert.equal(res.body.amountPaid, 27.2);
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.status, 'paid');
});

test('a 3dp client price is settled to 2dp once, so JS and Postgres cannot disagree', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemA = await createMenuItem(header, categoryId, 'Item A', 1);
  const itemB = await createMenuItem(header, categoryId, 'Item B', 1);

  // order_items.unit_price is numeric(10,2), which SILENTLY rounds a 3dp
  // input (the 9.6 lesson). So the price is settled in JS FIRST - 0.125
  // becomes 0.13 - and that one rounded value is used both for the
  // pre-insert total and for the insert itself. Postgres therefore stores
  // exactly what JS already computed against: 0.13 * 3 = 0.39 per line,
  // 0.78 across two lines.
  //
  // Verified against the real database: JS Number((0.125).toFixed(2)) and
  // Postgres 0.125::numeric(10,2) both give 0.13, and both give 0.39 for
  // 0.13 * 3. Had the total been derived from the raw 0.125 instead, the
  // pre-insert figure would be 0.76 while the stored order said 0.78, and
  // this sale would settle two pence short.
  const res = await sync(
    header,
    shopId,
    cashSyncBody(itemA, {
      items: [
        { menuItemId: itemA, quantity: 3, unitPrice: 0.125 },
        { menuItemId: itemB, quantity: 3, unitPrice: 0.125 },
      ],
      payment: { method: 'cash', amountTendered: 0.78 },
    })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].unitPrice, 0.13);
  assert.equal(res.body.items[0].lineTotal, 0.39);
  assert.equal(res.body.items[1].lineTotal, 0.39);
  assert.equal(res.body.subtotal, 0.78);
  assert.equal(res.body.total, 0.78);
  // The real assertion: the total the payment was settled against
  // (computed pre-insert, in JS) equals the total derived from the stored
  // rows. If those disagreed by a penny this would be partially_paid.
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.balanceDue, 0);
  assert.equal(res.body.amountPaid, 0.78);
});

test('a free line syncs at zero without being rejected as a missing price', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId, categoryId } = await tenPoundBurger(header);
  const sideId = await createMenuItem(header, categoryId, 'Comped side', 3);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, {
      items: [
        { menuItemId: burgerId, quantity: 1, unitPrice: 10 },
        { menuItemId: sideId, quantity: 1, unitPrice: 0 },
      ],
    })
  );

  assert.equal(res.status, 201);
  assert.equal(res.body.items[1].lineTotal, 0);
  assert.equal(res.body.total, 10);
  assert.equal(res.body.status, 'paid');
});

// --- Structural validation still protects tenancy ---

test('a menu item belonging to another company is rejected and writes nothing', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await tenPoundBurger(header);

  // A completely separate company's item.
  const other = await setupOwnerWithShop();
  const { burgerId: foreignItemId } = await tenPoundBurger(other.header);

  const res = await sync(header, shopId, cashSyncBody(foreignItemId));

  assert.equal(res.status, 404);
  assert.equal(await countOrders(shopId), 0);
});

test('a variant that does not belong to the ordered item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId, categoryId } = await tenPoundBurger(header);
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza', 12);
  const pizzaLargeId = await createVariant(header, pizzaId, 'Large', 15);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, {
      items: [{ menuItemId: burgerId, variantId: pizzaLargeId, quantity: 1, unitPrice: 15 }],
    })
  );

  assert.equal(res.status, 404);
  assert.match(res.body.error.message, /variant/i);
  assert.equal(await countOrders(shopId), 0);
});

test('a modifier option not attached to the ordered item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId, categoryId } = await tenPoundBurger(header);
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza', 12);
  const groupId = await createModifierGroup(header, 'Pizza extras', 0, 2);
  const olivesId = await createModifierOption(header, groupId, 'Olives', 0.8);
  await attachModifierGroupToItem(header, pizzaId, groupId);

  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, {
      items: [
        {
          menuItemId: burgerId,
          quantity: 1,
          unitPrice: 10,
          modifiers: [{ modifierOptionId: olivesId, priceDelta: 0.8 }],
        },
      ],
    })
  );

  assert.equal(res.status, 404);
  assert.match(res.body.error.message, /modifier/i);
  assert.equal(await countOrders(shopId), 0);
});

// --- Interaction with the rest of Module 9 ---

test('a synced order is locked exactly as a paid online order is', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const synced = await sync(header, shopId, cashSyncBody(burgerId));
  assert.equal(synced.body.status, 'paid');
  const orderId = synced.body.id;

  // These pass because 9.2/9.3/9.4's EXISTING status === 'open' guards stop
  // matching - not one line in those submodules changed for 9.7.
  const add = await request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: burgerId, quantity: 1 }] });
  assert.equal(add.status, 400);

  const discount = await request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/discount`)
    .set('Authorization', header)
    .send({ discountType: 'percentage', discountValue: 10 });
  assert.equal(discount.status, 400);

  const cancel = await request(app)
    .post(`/api/shops/${shopId}/orders/${orderId}/cancel`)
    .set('Authorization', header)
    .send({ wasPrepped: false });
  assert.equal(cancel.status, 400);
});

test("a synced own-terminal card payment refunds without calling the provider", async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const { burgerId } = await tenPoundBurger(header);
  const synced = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { payment: { method: 'card', amount: 10 } })
  );
  assert.equal(synced.status, 201);

  const paymentId = synced.body.payments[0].id;
  const refund = await request(app)
    .post(`/api/shops/${shopId}/orders/${synced.body.id}/payments/${paymentId}/refund`)
    .set('Authorization', header)
    .send({ amount: 10, reason: 'Customer returned it' });

  assert.equal(refund.status, 201);
  assert.equal(refund.body.status, 'refunded');
  // 9.6 keys off the PAYMENT's own null provider_reference, so it correctly
  // does not try to reverse a charge our provider never made.
  assert.equal(refund.body.payments[0].refunds[0].providerReference, null);
  assert.equal(refund.body.amountRefunded, 10);
  assert.equal(refund.body.netAmountPaid, 0);
});

test('a synced order can be fetched individually and reads back identically', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const body = cashSyncBody(burgerId);
  const synced = await sync(header, shopId, body);

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders/${synced.body.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.clientOrderId, body.clientOrderId);
  assert.equal(res.body.status, 'paid');
  assert.equal(res.body.amountPaid, 10);
});

// --- Permissions ---

test('a Server (ACCESS_TILL by default) can sync a queued sale', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await sync(serverHeader, shopId, cashSyncBody(burgerId));

  assert.equal(res.status, 201);
  assert.equal(res.body.createdByActorType, 'staff');
  assert.equal(res.body.createdByActorId, server.id);
});

test('a Chef (no ACCESS_TILL by default) cannot sync a queued sale', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await sync(chefHeader, shopId, cashSyncBody(burgerId));

  assert.equal(res.status, 403);
  assert.equal(await countOrders(shopId), 0);
});

// --- Validation ---

test('a queued sale must carry a clientOrderId, an occurredAt, items and a payment', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);
  const base = cashSyncBody(burgerId);

  const missingKey = await sync(header, shopId, { ...base, clientOrderId: undefined });
  assert.equal(missingKey.status, 400);

  const missingTime = await sync(header, shopId, { ...base, occurredAt: undefined });
  assert.equal(missingTime.status, 400);

  const badTime = await sync(header, shopId, { ...base, occurredAt: '2026-08-20' });
  assert.equal(badTime.status, 400, 'a bare date is not an instant');

  const noItems = await sync(header, shopId, { ...base, items: [] });
  assert.equal(noItems.status, 400);

  const noPayment = await sync(header, shopId, { ...base, payment: undefined });
  assert.equal(noPayment.status, 400);

  assert.equal(await countOrders(shopId), 0);
});

test('a queued line must carry the price it was actually charged at', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  // unitPrice is REQUIRED here, unlike the online flow which derives it -
  // an offline line with no price would have nothing to record.
  const res = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { items: [{ menuItemId: burgerId, quantity: 1 }] })
  );

  assert.equal(res.status, 400);
  assert.equal(await countOrders(shopId), 0);
});

test('a queued payment is validated per method, exactly as a live one is', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await setCardMode(header, 'own');
  const { burgerId } = await tenPoundBurger(header);
  const base = cashSyncBody(burgerId);

  const cashWithoutTendered = await sync(header, shopId, {
    ...base,
    payment: { method: 'cash' },
  });
  assert.equal(cashWithoutTendered.status, 400);

  const cardWithoutAmount = await sync(header, shopId, {
    ...base,
    payment: { method: 'card' },
  });
  assert.equal(cardWithoutAmount.status, 400);

  const unknownMethod = await sync(header, shopId, {
    ...base,
    payment: { method: 'cheque', amount: 10 },
  });
  assert.equal(unknownMethod.status, 400);

  assert.equal(await countOrders(shopId), 0);
});

test('a queued dine_in sale still requires a table number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const missing = await sync(header, shopId, cashSyncBody(burgerId, { type: 'dine_in' }));
  assert.equal(missing.status, 400);

  const ok = await sync(
    header,
    shopId,
    cashSyncBody(burgerId, { type: 'dine_in', tableNumber: '7' })
  );
  assert.equal(ok.status, 201);
  assert.equal(ok.body.tableNumber, '7');
});

test('a queued takeaway sale rejects a table number', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const { burgerId } = await tenPoundBurger(header);

  const res = await sync(header, shopId, cashSyncBody(burgerId, { tableNumber: '7' }));

  assert.equal(res.status, 400);
});

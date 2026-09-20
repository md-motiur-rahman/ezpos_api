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
    [uniqueEmail('owner'), passwordHash]
  );
  return rows[0].id;
}

function authHeaderFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

const VALID_COMPANY = {
  name: 'Test Restaurant Ltd',
  addressLine1: '1 High Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  country: 'UK',
  phone: '02012345678',
};

// --- Auth guard ---

test('company endpoints reject requests with no auth token', async () => {
  const createRes = await request(app).post('/api/companies').send(VALID_COMPANY);
  const getRes = await request(app).get('/api/companies/mine');

  assert.equal(createRes.status, 401);
  assert.equal(getRes.status, 401);
});

// --- POST /api/companies ---

test('POST /api/companies creates a company for the authenticated owner', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 201);
  assert.equal(res.body.name, VALID_COMPANY.name);
});

test('POST /api/companies rejects a second active company for the same owner', async () => {
  const userId = await insertUser();

  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);
  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 409);
});

test('POST /api/companies allows a new company after the previous one was soft-deleted', async () => {
  const userId = await insertUser();

  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);
  await query(`UPDATE companies SET deleted_at = now() WHERE owner_user_id = $1`, [userId]);

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);

  assert.equal(res.status, 201);
});

test('POST /api/companies rejects missing required fields', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send({ name: 'Missing Everything Else Ltd' });

  assert.equal(res.status, 400);
});

// --- GET /api/companies/mine ---

test('GET /api/companies/mine returns the owner active company', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 200);
  assert.equal(res.body.name, VALID_COMPANY.name);
});

test('GET /api/companies/mine returns 404 when the owner has no company', async () => {
  const userId = await insertUser();

  const res = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 404);
});

// --- PATCH /api/companies/mine ---

test('PATCH /api/companies/mine updates only the provided fields', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .patch('/api/companies/mine')
    .set('Authorization', authHeaderFor(userId))
    .send({ city: 'Manchester' });

  assert.equal(res.status, 200);
  assert.equal(res.body.city, 'Manchester');
  assert.equal(res.body.name, VALID_COMPANY.name); // untouched fields preserved
});

// --- DELETE /api/companies/mine ---

test('DELETE /api/companies/mine soft-deletes and GET afterward returns 404', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const deleteRes = await request(app)
    .delete('/api/companies/mine')
    .set('Authorization', authHeaderFor(userId));
  assert.equal(deleteRes.status, 200);

  const getRes = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));
  assert.equal(getRes.status, 404);
});

// --- POST /api/companies/mine/business-type ---

test('POST /api/companies/mine/business-type sets the value to single', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'single');
});

test('POST /api/companies/mine/business-type sets the value to chain', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'chain');
});

test('POST /api/companies/mine/business-type allows switching direction freely for now', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });
  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 200);
  assert.equal(res.body.businessType, 'single');
});

test('POST /api/companies/mine/business-type rejects an invalid value', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'franchise' });

  assert.equal(res.status, 400);
});

test('POST /api/companies/mine/business-type returns 404 with no active company', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  assert.equal(res.status, 404);
});

test('POST /api/companies/mine/business-type rejects requests with no auth token', async () => {
  const res = await request(app).post('/api/companies/mine/business-type').send({ businessType: 'single' });

  assert.equal(res.status, 401);
});

test('GET /api/companies/mine reflects businessType, including null before it is ever set', async () => {
  const userId = await insertUser();
  const createRes = await request(app)
    .post('/api/companies')
    .set('Authorization', authHeaderFor(userId))
    .send(VALID_COMPANY);
  assert.equal(createRes.body.businessType, null);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });

  const getRes = await request(app).get('/api/companies/mine').set('Authorization', authHeaderFor(userId));
  assert.equal(getRes.body.businessType, 'chain');
});

// --- Stripe customer creation (Module 3.1) ---

test('setting business_type for the first time creates a stripe_customer_id', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const { rows: before } = await query(
    `SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1`,
    [userId]
  );
  assert.equal(before[0].stripe_customer_id, null);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });

  const { rows: after } = await query(
    `SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1`,
    [userId]
  );
  assert.ok(after[0].stripe_customer_id);
  assert.ok(after[0].stripe_customer_id.startsWith('cus_test_'));
});

test('setting business_type again does not create a second stripe_customer_id', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'chain' });
  const { rows: first } = await query(
    `SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1`,
    [userId]
  );

  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', authHeaderFor(userId))
    .send({ businessType: 'single' });
  const { rows: second } = await query(
    `SELECT stripe_customer_id FROM companies WHERE owner_user_id = $1`,
    [userId]
  );

  assert.equal(first[0].stripe_customer_id, second[0].stripe_customer_id);
});

// --- GET /api/companies/mine/billing-history (Module 3.7) ---

test('billing-history returns an empty list when the company has no Stripe customer yet', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .get('/api/companies/mine/billing-history')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { invoices: [], hasMore: false });
});

test('billing-history returns invoices once the company has a Stripe customer', async () => {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });

  const res = await request(app).get('/api/companies/mine/billing-history').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.invoices.length, 2);
  assert.equal(res.body.invoices[0].status, 'paid');
  assert.equal(res.body.invoices[1].status, 'open');
  assert.equal(res.body.invoices[0].amountDue, 2999);
  assert.ok(res.body.invoices[0].hostedInvoiceUrl);
  assert.equal(res.body.hasMore, false);
});

test('billing-history rejects a limit of 0', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .get('/api/companies/mine/billing-history?limit=0')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 400);
});

test('billing-history rejects a limit over 100', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .get('/api/companies/mine/billing-history?limit=101')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 400);
});

test('billing-history returns 404 with no active company', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .get('/api/companies/mine/billing-history')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 404);
});

test('billing-history rejects requests with no auth token', async () => {
  const res = await request(app).get('/api/companies/mine/billing-history');

  assert.equal(res.status, 401);
});

test('billing-history is accessible even when the company is billing-locked', async () => {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType: 'single' });
  await query(
    `UPDATE companies SET subscription_status = 'past_due',
            grace_period_ends_at = now() - interval '1 day'
     WHERE owner_user_id = $1`,
    [userId]
  );

  const res = await request(app).get('/api/companies/mine/billing-history').set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.invoices.length, 2);
});

// --- GET /api/companies/mine/dashboard-summary (Module 15.1) ---

async function insertShop(companyId, name = 'Test Shop') {
  const { rows } = await query(
    `INSERT INTO shops (company_id, name, address_line1, city, postcode, country, phone, vat_registered)
     VALUES ($1, $2, '1 St', 'London', 'E1 1AA', 'UK', '02012345678', true)
     RETURNING id`,
    [companyId, name]
  );
  return rows[0].id;
}

async function insertOrder(shopId, createdAt) {
  const { rows } = await query(
    `INSERT INTO orders (shop_id, type, created_by_actor_type, created_by_actor_id, created_at, updated_at)
     VALUES ($1, 'takeaway', 'owner', $2, $3, $3)
     RETURNING id`,
    [shopId, crypto.randomUUID(), createdAt]
  );
  return rows[0].id;
}

async function insertPayment(orderId, amount, createdAt) {
  const { rows } = await query(
    `INSERT INTO order_payments (order_id, method, amount, paid_by_actor_type, paid_by_actor_id, created_at)
     VALUES ($1, 'cash', $2, 'owner', $3, $4)
     RETURNING id`,
    [orderId, amount, crypto.randomUUID(), createdAt]
  );
  return rows[0].id;
}

async function insertRefund(paymentId, amount, createdAt) {
  await query(
    `INSERT INTO order_refunds (payment_id, amount, refunded_by_actor_type, refunded_by_actor_id, created_at)
     VALUES ($1, $2, 'owner', $3, $4)`,
    [paymentId, amount, crypto.randomUUID(), createdAt]
  );
}

async function insertPurchaseOrderWithCost(shopId, supplierId, inventoryItemId, cost, orderedAt) {
  const { rows } = await query(
    `INSERT INTO purchase_orders (shop_id, supplier_id, ordered_at) VALUES ($1, $2, $3) RETURNING id`,
    [shopId, supplierId, orderedAt]
  );
  await query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, quantity, unit_cost)
     VALUES ($1, $2, 1, $3)`,
    [rows[0].id, inventoryItemId, cost]
  );
}

async function insertSupplier(shopId) {
  const { rows } = await query(`INSERT INTO suppliers (shop_id, name) VALUES ($1, 'Test Supplier') RETURNING id`, [
    shopId,
  ]);
  return rows[0].id;
}

async function insertInventoryItem(shopId) {
  const { rows } = await query(
    `INSERT INTO inventory_items (shop_id, name, unit) VALUES ($1, 'Test Item', 'each') RETURNING id`,
    [shopId]
  );
  return rows[0].id;
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

test('dashboard-summary rejects requests with no auth token', async () => {
  const res = await request(app).get('/api/companies/mine/dashboard-summary');

  assert.equal(res.status, 401);
});

test('dashboard-summary returns 404 with no active company', async () => {
  const userId = await insertUser();

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 404);
});

test('dashboard-summary rejects an out-of-range days value', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=91')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 400);
});

test('dashboard-summary returns a zeroed series and no shops for a company with none yet', async () => {
  const userId = await insertUser();
  await request(app).post('/api/companies').set('Authorization', authHeaderFor(userId)).send(VALID_COMPANY);

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=7')
    .set('Authorization', authHeaderFor(userId));

  assert.equal(res.status, 200);
  assert.equal(res.body.shopCount, 0);
  assert.deepEqual(res.body.shopBreakdown, []);
  assert.equal(res.body.series.length, 7);
  assert.ok(res.body.series.every((day) => day.revenue === 0 && day.expense === 0));
  assert.deepEqual(res.body.totals, { revenue: 0, expense: 0, orderCount: 0, net: 0 });
});

test('dashboard-summary nets revenue against refunds, sums purchase-order cost as expense, and excludes activity outside the window', async () => {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  const createRes = await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  const companyId = createRes.body.id;
  const shopId = await insertShop(companyId);
  const supplierId = await insertSupplier(shopId);
  const itemId = await insertInventoryItem(shopId);

  // Today: a £50 payment partially refunded £20 -> £30 net revenue, plus a
  // £12 purchase-order cost.
  const orderToday = await insertOrder(shopId, daysAgo(0));
  const paymentToday = await insertPayment(orderToday, 50, daysAgo(0));
  await insertRefund(paymentToday, 20, daysAgo(0));
  await insertPurchaseOrderWithCost(shopId, supplierId, itemId, 12, daysAgo(0));

  // Outside the 7-day window - must not be counted.
  const orderOld = await insertOrder(shopId, daysAgo(30));
  await insertPayment(orderOld, 999, daysAgo(30));
  await insertPurchaseOrderWithCost(shopId, supplierId, itemId, 999, daysAgo(30));

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=7')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.shopCount, 1);
  assert.equal(res.body.series.length, 7);
  const todayRow = res.body.series[res.body.series.length - 1];
  assert.equal(todayRow.revenue, 30);
  assert.equal(todayRow.expense, 12);
  assert.equal(todayRow.orderCount, 1);
  assert.equal(res.body.totals.revenue, 30);
  assert.equal(res.body.totals.expense, 12);
  assert.equal(res.body.totals.net, 18);
  assert.equal(res.body.totals.orderCount, 1);
  assert.equal(res.body.shopBreakdown.length, 1);
  assert.equal(res.body.shopBreakdown[0].shopId, shopId);
  assert.equal(res.body.shopBreakdown[0].revenue, 30);
});

test('dashboard-summary ranks shopBreakdown by revenue, highest first', async () => {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  const createRes = await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  const companyId = createRes.body.id;
  const quietShop = await insertShop(companyId, 'Quiet Shop');
  const busyShop = await insertShop(companyId, 'Busy Shop');

  const quietOrder = await insertOrder(quietShop, daysAgo(0));
  await insertPayment(quietOrder, 10, daysAgo(0));
  const busyOrder = await insertOrder(busyShop, daysAgo(0));
  await insertPayment(busyOrder, 500, daysAgo(0));

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=7')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.shopBreakdown[0].shopId, busyShop);
  assert.equal(res.body.shopBreakdown[1].shopId, quietShop);
});

test('dashboard-summary is accessible even when the company is billing-locked', async () => {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await query(
    `UPDATE companies SET subscription_status = 'past_due',
            grace_period_ends_at = now() - interval '1 day'
     WHERE owner_user_id = $1`,
    [userId]
  );

  const res = await request(app).get('/api/companies/mine/dashboard-summary').set('Authorization', header);

  assert.equal(res.status, 200);
});

test('dashboard-summary totals are exact, not raw IEEE-754 noise, when summing across days', async () => {
  // The classic case, empirically confirmed before this fix: Number('10.10')
  // + Number('20.20') is 30.299999999999997 in plain JS float arithmetic,
  // not 30.3 - not a corner case, the ordinary result of summing decimal
  // fractions in binary floating point. Spread across two different days so
  // the sum genuinely happens in JS (company.service.js), not in SQL.
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  const createRes = await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  const shopId = await insertShop(createRes.body.id);

  const orderToday = await insertOrder(shopId, daysAgo(0));
  await insertPayment(orderToday, 10.1, daysAgo(0));
  const orderYesterday = await insertOrder(shopId, daysAgo(1));
  await insertPayment(orderYesterday, 20.2, daysAgo(1));

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=7')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.totals.revenue, 30.3);
  assert.equal(res.body.totals.net, 30.3);
  // The raw response body text (before JSON parsing folds it back) is where
  // the noise would actually be visible to a real client - asserting
  // against the parsed number alone could pass even if node's JSON parser
  // happened to mask a difference, so this checks the wire format too.
  assert.match(res.text, /"revenue":30\.3[,}]/);
});

test('dashboard-summary shopBreakdown excludes a future-dated payment, staying consistent with the day-by-day series', async () => {
  // series is naturally protected from anything past today (it's driven
  // FROM a generate_series truncated to current_date, so a future row has
  // no day to join into) - shopBreakdown has no such structural protection,
  // since it's driven FROM shops and joined on shop_id, not on any day
  // boundary. Without an explicit upper bound, a future-dated row would
  // inflate shopBreakdown's revenue while series (and its own totals)
  // stayed unaffected - two views of the same money silently disagreeing.
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  const createRes = await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  const shopId = await insertShop(createRes.body.id);

  const orderToday = await insertOrder(shopId, daysAgo(0));
  await insertPayment(orderToday, 15, daysAgo(0));
  const orderFuture = await insertOrder(shopId, daysAgo(-5));
  await insertPayment(orderFuture, 1000, daysAgo(-5));

  const res = await request(app)
    .get('/api/companies/mine/dashboard-summary?days=7')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.shopBreakdown.length, 1);
  assert.equal(res.body.shopBreakdown[0].shopId, shopId);
  assert.equal(res.body.shopBreakdown[0].revenue, 15, 'the future-dated £1000 payment must not be counted');
  assert.equal(res.body.totals.revenue, 15, 'series-derived totals must agree with shopBreakdown');
});
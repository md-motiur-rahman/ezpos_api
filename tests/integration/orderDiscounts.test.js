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
    [uniqueEmail('order-discount-owner'), passwordHash]
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
      name: `Order Discount Test Ltd ${crypto.randomUUID()}`,
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

async function setOrderDiscount(header, shopId, orderId, body) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/discount`)
    .set('Authorization', header)
    .send(body);
}

async function setItemDiscount(header, shopId, orderId, orderItemId, body) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/discount`)
    .set('Authorization', header)
    .send(body);
}

// --- Order-level discounts ---

test('a percentage order discount reduces the total, subtotal unchanged', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 2 }], // subtotal 20
  });

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: 'percentage',
    discountValue: 10,
    reason: 'Loyal customer',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.subtotal, 20);
  assert.equal(res.body.discount.type, 'percentage');
  assert.equal(res.body.discount.value, 10);
  assert.equal(res.body.discount.reason, 'Loyal customer');
  assert.equal(res.body.discountAmount, 2);
  assert.equal(res.body.total, 18);
});

test('a fixed order discount reduces the total by the exact amount', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 2 }], // subtotal 20
  });

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: 'fixed',
    discountValue: 5,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.discountAmount, 5);
  assert.equal(res.body.total, 15);
});

test('a fixed order discount larger than the subtotal is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }], // subtotal 10
  });

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: 'fixed',
    discountValue: 10.01,
  });

  assert.equal(res.status, 400);
});

test('a percentage discount above 100 is rejected by validation', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: 'percentage',
    discountValue: 150,
  });

  assert.equal(res.status, 400);
});

test('an order discount can be explicitly cleared', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await setOrderDiscount(header, shopId, order.id, { discountType: 'fixed', discountValue: 3 });

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: null,
    discountValue: null,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.discount, null);
  assert.equal(res.body.discountAmount, 0);
  assert.equal(res.body.total, 10);
});

test('a discount recomputes live against a subtotal that grows after 9.2 adds items', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 5);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }], // subtotal 10
  });
  await setOrderDiscount(header, shopId, order.id, { discountType: 'percentage', discountValue: 10 });

  await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items`)
    .set('Authorization', header)
    .send({ items: [{ menuItemId: friesId, quantity: 1 }] }); // subtotal now 15

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders/${order.id}`)
    .set('Authorization', header);

  assert.equal(res.body.subtotal, 15);
  assert.equal(res.body.discountAmount, 1.5);
  assert.equal(res.body.total, 13.5);
});

// --- Line-item discounts ---

test('a line-item discount only affects that line, subtotal stays pre-discount', async () => {
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
  const burgerLine = order.items.find((item) => item.menuItemId === burgerId);

  const res = await setItemDiscount(header, shopId, order.id, burgerLine.id, {
    discountType: 'fixed',
    discountValue: 4,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.subtotal, 15);
  assert.equal(res.body.itemDiscountTotal, 4);
  assert.equal(res.body.total, 11);
  const discountedLine = res.body.items.find((item) => item.id === burgerLine.id);
  assert.equal(discountedLine.lineTotal, 10);
  assert.equal(discountedLine.total, 6);
  const untouchedLine = res.body.items.find((item) => item.id !== burgerLine.id);
  assert.equal(untouchedLine.discount, null);
  assert.equal(untouchedLine.total, 5);
});

test('a line-item fixed discount larger than that line is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const res = await setItemDiscount(header, shopId, order.id, order.items[0].id, {
    discountType: 'fixed',
    discountValue: 10.01,
  });

  assert.equal(res.status, 400);
});

test('line-item and order-level discounts combine, item discount applied first', async () => {
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
  const burgerLine = order.items.find((item) => item.menuItemId === burgerId);
  await setItemDiscount(header, shopId, order.id, burgerLine.id, {
    discountType: 'fixed',
    discountValue: 4,
  }); // subtotal-after-item-discounts now 11 (15 - 4)

  const res = await setOrderDiscount(header, shopId, order.id, {
    discountType: 'percentage',
    discountValue: 10,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.itemDiscountTotal, 4);
  assert.equal(res.body.discountAmount, 1.1); // 10% of 11
  assert.equal(res.body.total, 9.9);
});

test('a line-item discount can be explicitly cleared', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });
  await setItemDiscount(header, shopId, order.id, order.items[0].id, {
    discountType: 'fixed',
    discountValue: 3,
  });

  const res = await setItemDiscount(header, shopId, order.id, order.items[0].id, {
    discountType: null,
    discountValue: null,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].discount, null);
  assert.equal(res.body.total, 10);
});

test('discounting an order item that does not belong to the order is a 404', async () => {
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

  const res = await setItemDiscount(header, shopId, orderA.id, orderB.items[0].id, {
    discountType: 'fixed',
    discountValue: 1,
  });

  assert.equal(res.status, 404);
});

// --- Scoping ---

test('discounting an order that does not exist is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await setOrderDiscount(header, shopId, '00000000-0000-0000-0000-000000000000', {
    discountType: 'fixed',
    discountValue: 1,
  });

  assert.equal(res.status, 404);
});

// --- Permissions ---

test('a Manager (has APPLY_DISCOUNT by default) can apply an order discount', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const manager = await insertStaff(shopId, 'manager');
  const managerHeader = await staffHeaderFor(shopId, manager.staffIdCode);

  const res = await setOrderDiscount(managerHeader, shopId, order.id, {
    discountType: 'fixed',
    discountValue: 1,
  });

  assert.equal(res.status, 200);
});

test('a Server (no APPLY_DISCOUNT by default) cannot apply a discount', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 10);
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: burgerId, quantity: 1 }],
  });

  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await setOrderDiscount(serverHeader, shopId, order.id, {
    discountType: 'fixed',
    discountValue: 1,
  });

  assert.equal(res.status, 403);
});

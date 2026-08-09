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
    [uniqueEmail('order-creation-owner'), passwordHash]
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
      name: `Order Creation Test Ltd ${crypto.randomUUID()}`,
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

async function createLocalItem(header, shopId, categoryId, name, price) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId, name, price });
  return res.body.id;
}

async function setItemOverride(header, shopId, menuItemId, data) {
  await request(app)
    .patch(`/api/shops/${shopId}/menu/overrides/${menuItemId}`)
    .set('Authorization', header)
    .send(data);
}

async function setVariantOverride(header, shopId, variantId, data) {
  await request(app)
    .patch(`/api/shops/${shopId}/menu/variants/${variantId}`)
    .set('Authorization', header)
    .send(data);
}

async function setModifierOptionOverride(header, shopId, optionId, data) {
  await request(app)
    .patch(`/api/shops/${shopId}/menu/modifier-options/${optionId}`)
    .set('Authorization', header)
    .send(data);
}

async function createOrder(header, shopId, body) {
  return request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send(body);
}

// --- Order type / table validation ---

test('a dine_in order requires a tableNumber', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const res = await createOrder(header, shopId, {
    type: 'dine_in',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

test('a dine_in order with a tableNumber succeeds', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const res = await createOrder(header, shopId, {
    type: 'dine_in',
    tableNumber: '12',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.type, 'dine_in');
  assert.equal(res.body.tableNumber, '12');
  assert.equal(res.body.status, 'open');
});

test('a takeaway order with a tableNumber is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    tableNumber: '5',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

test('a takeaway order with a customerName and no table succeeds', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    customerName: 'Sarah',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.customerName, 'Sarah');
  assert.equal(res.body.tableNumber, null);
});

test('an order with zero items is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [],
  });

  assert.equal(res.status, 400);
});

// --- Pricing resolution ---

test('a master item order line prices at the item price times quantity', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 3 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].unitPrice, 8);
  assert.equal(res.body.items[0].lineTotal, 24);
  assert.equal(res.body.subtotal, 24);
});

test('a local (shop-exclusive) item order line resolves and prices correctly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const localItemId = await createLocalItem(header, shopId, categoryId, 'Local Special', 6.5);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ shopMenuItemId: localItemId, quantity: 2 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].unitPrice, 6.5);
  assert.equal(res.body.items[0].lineTotal, 13);
});

test('a shop price override changes the resolved unit price', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  await setItemOverride(header, shopId, itemId, { priceOverride: 9.5 });

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.items[0].unitPrice, 9.5);
});

test('a variant price REPLACES the base item price, not adds to it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Pizza', 8);
  const variantId = await createVariant(header, itemId, 'Large', 12);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, variantId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
  // 12, NOT 8 (base) and NOT 20 (8+12 added) - absolute replacement.
  assert.equal(res.body.items[0].unitPrice, 12);
});

test('modifier price deltas ADD to the unit price, itemized separately', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const groupId = await createModifierGroup(header, 'Extras', 0, 2);
  const cheeseId = await createModifierOption(header, groupId, 'Extra Cheese', 1);
  await attachModifierGroupToItem(header, itemId, groupId);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, modifierOptionIds: [cheeseId], quantity: 2 }],
  });

  assert.equal(res.status, 201);
  const line = res.body.items[0];
  assert.equal(line.unitPrice, 8);
  assert.equal(line.modifiers.length, 1);
  assert.equal(line.modifiers[0].priceDelta, 1);
  // (8 + 1) * 2 = 18
  assert.equal(line.lineTotal, 18);
});

// --- Modifier group min/max enforcement ---

test('selecting fewer than a required group minimum is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Pizza', 8);
  const groupId = await createModifierGroup(header, 'Size', 1, 1);
  await createModifierOption(header, groupId, 'Small', 0);
  await attachModifierGroupToItem(header, itemId, groupId);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }], // no modifierOptionIds - Size is required
  });

  assert.equal(res.status, 400);
});

test('selecting more than a group maximum is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const groupId = await createModifierGroup(header, 'Extras', 0, 1);
  const cheeseId = await createModifierOption(header, groupId, 'Extra Cheese', 1);
  const baconId = await createModifierOption(header, groupId, 'Bacon', 1.5);
  await attachModifierGroupToItem(header, itemId, groupId);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, modifierOptionIds: [cheeseId, baconId], quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

test('a valid selection within min/max succeeds', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Pizza', 8);
  const groupId = await createModifierGroup(header, 'Size', 1, 1);
  const smallId = await createModifierOption(header, groupId, 'Small', 0);
  await attachModifierGroupToItem(header, itemId, groupId);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, modifierOptionIds: [smallId], quantity: 1 }],
  });

  assert.equal(res.status, 201);
});

// --- Not found / disabled ---

test('a nonexistent menuItemId is a 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: '00000000-0000-0000-0000-000000000000', quantity: 1 }],
  });

  assert.equal(res.status, 404);
});

test('a disabled item is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  await setItemOverride(header, shopId, itemId, { isEnabled: false });

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

test('a disabled variant is rejected even though the base item is enabled', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Pizza', 8);
  const variantId = await createVariant(header, itemId, 'Large', 12);
  await setVariantOverride(header, shopId, variantId, { isEnabled: false });

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, variantId, quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

test('a disabled modifier option is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const groupId = await createModifierGroup(header, 'Extras', 0, 1);
  const cheeseId = await createModifierOption(header, groupId, 'Extra Cheese', 1);
  await attachModifierGroupToItem(header, itemId, groupId);
  await setModifierOptionOverride(header, shopId, cheeseId, { isEnabled: false });

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, modifierOptionIds: [cheeseId], quantity: 1 }],
  });

  assert.equal(res.status, 400);
});

// --- Multi-line orders ---

test('an order with multiple lines totals correctly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const burgerId = await createMenuItem(header, categoryId, 'Burger', 8);
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);

  const res = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: burgerId, quantity: 2 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.items.length, 2);
  // (8*2) + (3*1) = 19
  assert.equal(res.body.subtotal, 19);
});

// --- Read endpoints ---

test('GET list and GET by id return the created order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const created = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/orders`)
    .set('Authorization', header);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.length, 1);
  assert.equal(listRes.body[0].id, created.body.id);
  assert.equal(listRes.body[0].itemCount, 1);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/orders/${created.body.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.subtotal, 8);
});

test('an order from another shop is a 404', async () => {
  const { header: headerA, shopId: shopAId } = await setupOwnerWithShop();
  const { header: headerB, shopId: shopBId } = await setupOwnerWithShop();
  const categoryId = await createCategory(headerA, 'Mains');
  const itemId = await createMenuItem(headerA, categoryId, 'Burger', 8);
  const created = await createOrder(headerA, shopAId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  const res = await request(app)
    .get(`/api/shops/${shopBId}/orders/${created.body.id}`)
    .set('Authorization', headerB);

  assert.equal(res.status, 404);
});

// --- Permissions ---

test('a Server (has ACCESS_TILL) can create an order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await createOrder(serverHeader, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 201);
});

test('a Chef (no ACCESS_TILL by default) cannot create an order', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const itemId = await createMenuItem(header, categoryId, 'Burger', 8);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await createOrder(chefHeader, shopId, {
    type: 'takeaway',
    items: [{ menuItemId: itemId, quantity: 1 }],
  });

  assert.equal(res.status, 403);
});

test('a Chef cannot list orders either', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/orders`)
    .set('Authorization', chefHeader);

  assert.equal(res.status, 403);
});

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
 * 10.3 - the per-item inventory deduction trigger.
 *
 * 7.9's engine has its own tests (inventoryDeduction.test.js) covering the
 * recipe maths itself - additive variants/modifiers, conversion factors,
 * aggregation, going negative. These tests are about the TRIGGER: that
 * reaching a deducting status moves stock, that it moves EXACTLY ONCE
 * however many times the status is re-entered, and that nothing 10.2
 * already shipped changed.
 */

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('order-deduction-owner'), passwordHash]
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
      name: `Order Deduction Test Ltd ${crypto.randomUUID()}`,
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

async function createMenuItem(header, categoryId, name, price = 10) {
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId, name, price });
  return res.body.id;
}

async function createIngredient(header, name, unit = 'g') {
  const res = await request(app)
    .post('/api/companies/mine/ingredients')
    .set('Authorization', header)
    .send({ name, unit });
  return res.body.id;
}

async function attachIngredientToItem(header, itemId, ingredientId, quantity) {
  await request(app)
    .post(`/api/companies/mine/menu-items/${itemId}/ingredients/${ingredientId}`)
    .set('Authorization', header)
    .send({ quantity });
}

async function createInventoryItem(header, shopId, data) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
  return res.body.id;
}

async function linkIngredient(header, shopId, itemId, ingredientId, conversionFactor = 1) {
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send({ conversionFactor });
}

async function stockLevel(header, shopId, itemId) {
  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}`)
    .set('Authorization', header);
  return res.body.quantityOnHand;
}

async function createOrder(header, shopId, body) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/orders`)
    .set('Authorization', header)
    .send(body);
  return res.body;
}

function setStatus(header, shopId, orderId, orderItemId, status) {
  return request(app)
    .patch(`/api/shops/${shopId}/orders/${orderId}/items/${orderItemId}/status`)
    .set('Authorization', header)
    .send({ status });
}

/** Reads the 10.3 marker straight from the DB - it is deliberately NOT in the API response. */
async function deductedAt(orderItemId) {
  const { rows } = await query(`SELECT inventory_deducted_at FROM order_items WHERE id = $1`, [
    orderItemId,
  ]);
  return rows[0].inventory_deducted_at;
}

/**
 * The standard fixture: one menu item whose recipe uses 200g of an
 * ingredient, backed by 1000g of linked stock. One sale of quantity 1
 * should therefore leave 800.
 */
async function shopWithLinkedRecipe(overrides = {}) {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const ingredientId = await createIngredient(header, 'Dough');
  await attachIngredientToItem(header, menuItemId, ingredientId, overrides.recipeQuantity ?? 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: overrides.stock ?? 1000,
  });
  await linkIngredient(header, shopId, stockItemId, ingredientId);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId, quantity: overrides.quantity ?? 1 }],
  });

  return {
    header,
    shopId,
    categoryId,
    menuItemId,
    ingredientId,
    stockItemId,
    order,
    orderItemId: order.items[0].id,
  };
}

// --- The core trigger ---

test('moving an item to ready deducts its recipe from linked stock', async () => {
  const f = await shopWithLinkedRecipe();

  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 1000, 'baseline before');
  assert.equal(await deductedAt(f.orderItemId), null, 'not deducted before the trigger');

  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');

  assert.equal(res.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
  assert.ok(await deductedAt(f.orderItemId), 'inventory_deducted_at must be stamped');
});

test('the line quantity multiplies the deduction', async () => {
  const f = await shopWithLinkedRecipe({ quantity: 3 });

  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');

  // 1000 - (200 x 3) = 400
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 400);
});

test('statuses before ready do not deduct anything', async () => {
  const f = await shopWithLinkedRecipe();

  const pending = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'pending');
  const inProgress = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'in_progress');

  assert.equal(pending.status, 200);
  assert.equal(inProgress.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 1000, 'stock untouched');
  assert.equal(await deductedAt(f.orderItemId), null);
});

// --- Idempotency: the load-bearing property of this submodule ---

test('re-entering ready after a correction does NOT deduct a second time', async () => {
  const f = await shopWithLinkedRecipe();

  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
  const firstClaim = await deductedAt(f.orderItemId);

  // 10.2 deliberately allows a backward correction, and it must not undo or
  // re-arm the deduction.
  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'in_progress');
  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');

  assert.equal(
    await stockLevel(f.header, f.shopId, f.stockItemId),
    800,
    'stock must move exactly once, however many times ready is re-entered'
  );
  assert.deepEqual(
    await deductedAt(f.orderItemId),
    firstClaim,
    'the original claim timestamp must be preserved, not overwritten'
  );
});

test('ready then served deducts exactly once, not twice', async () => {
  const f = await shopWithLinkedRecipe();

  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'served');

  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
});

test('jumping straight from pending to served still deducts (the skip-ahead backstop)', async () => {
  const f = await shopWithLinkedRecipe();

  // 10.2 explicitly supports this jump. Without 'served' in
  // INVENTORY_DEDUCTION_STATUSES this real sale would silently never deduct.
  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'served');

  assert.equal(res.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
});

test('two simultaneous ready calls on the same item deduct only once', async () => {
  const f = await shopWithLinkedRecipe();

  // Fired together rather than awaited in sequence - this is the two-KDS-
  // screens case the atomic claim exists for.
  const [a, b] = await Promise.all([
    setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready'),
    setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready'),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(
    await stockLevel(f.header, f.shopId, f.stockItemId),
    800,
    'exactly one of the two concurrent calls may win the claim'
  );
});

// --- Scope: only the item actually marked ready ---

test('only the item marked ready deducts - its siblings are untouched', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza');
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);
  const doughId = await createIngredient(header, 'Dough');
  const potatoId = await createIngredient(header, 'Potato');
  await attachIngredientToItem(header, pizzaId, doughId, 200);
  await attachIngredientToItem(header, friesId, potatoId, 150);

  const doughStockId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  const potatoStockId = await createInventoryItem(header, shopId, {
    name: 'Potato Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, doughStockId, doughId);
  await linkIngredient(header, shopId, potatoStockId, potatoId);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: pizzaId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const pizzaItemId = order.items.find((i) => i.menuItemId === pizzaId).id;

  await setStatus(header, shopId, order.id, pizzaItemId, 'ready');

  assert.equal(await stockLevel(header, shopId, doughStockId), 800, 'the ready item deducted');
  assert.equal(
    await stockLevel(header, shopId, potatoStockId),
    1000,
    'the still-pending item must not have deducted'
  );
});

// --- A shop-local menu item (the other branch of 7.9's resolution) ---

test('a shop-local menu item deducts through the same trigger', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const localRes = await request(app)
    .post(`/api/shops/${shopId}/menu/items`)
    .set('Authorization', header)
    .send({ categoryId, name: 'Local Special', price: 8 });
  const localItemId = localRes.body.id;

  const ingredientId = await createIngredient(header, 'Local Sauce', 'ml');
  await request(app)
    .post(`/api/shops/${shopId}/menu/items/${localItemId}/ingredients/${ingredientId}`)
    .set('Authorization', header)
    .send({ quantity: 30 });

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Sauce Stock',
    unit: 'ml',
    quantityOnHand: 500,
  });
  await linkIngredient(header, shopId, stockItemId, ingredientId);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ shopMenuItemId: localItemId, quantity: 2 }],
  });

  const res = await setStatus(header, shopId, order.id, order.items[0].id, 'ready');

  assert.equal(res.status, 200);
  // 500 - (30 x 2) = 440
  assert.equal(await stockLevel(header, shopId, stockItemId), 440);
});

// --- 7.9's own rules reaching through the trigger unchanged ---

test('an ingredient with no linked stock item is skipped without failing the status update', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough');
  const oreganoId = await createIngredient(header, 'Oregano');
  await attachIngredientToItem(header, menuItemId, doughId, 200);
  await attachIngredientToItem(header, menuItemId, oreganoId, 5);

  const doughStockId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  // Oregano deliberately left unlinked.
  await linkIngredient(header, shopId, doughStockId, doughId);

  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId, quantity: 1 }],
  });

  const res = await setStatus(header, shopId, order.id, order.items[0].id, 'ready');

  assert.equal(res.status, 200, 'an unconfigured ingredient must not fail the kitchen action');
  assert.equal(await stockLevel(header, shopId, doughStockId), 800, 'the linked one still deducted');
});

test('an item with no recipe at all still advances to ready with no stock movement', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Plain Item');
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [{ menuItemId, quantity: 1 }],
  });

  const res = await setStatus(header, shopId, order.id, order.items[0].id, 'ready');

  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].status, 'ready');
});

test('insufficient stock goes negative rather than blocking the kitchen', async () => {
  const f = await shopWithLinkedRecipe({ stock: 100 });

  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');

  // 7.9's confirmed rule, unchanged: the food is already made, so a visible
  // negative beats a silently undeducted sale. Deliberately NOT 7.7's 409.
  assert.equal(res.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), -100);
});

// --- No reversal (same philosophy as 8.4/9.4) ---

test('voiding an already-deducted item does NOT restore its stock', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza');
  const friesId = await createMenuItem(header, categoryId, 'Fries', 3);
  const doughId = await createIngredient(header, 'Dough');
  await attachIngredientToItem(header, pizzaId, doughId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, doughId);

  // Two lines, so the pizza is not the LAST active item (9.4 blocks voiding that).
  const order = await createOrder(header, shopId, {
    type: 'takeaway',
    items: [
      { menuItemId: pizzaId, quantity: 1 },
      { menuItemId: friesId, quantity: 1 },
    ],
  });
  const pizzaItemId = order.items.find((i) => i.menuItemId === pizzaId).id;

  await setStatus(header, shopId, order.id, pizzaItemId, 'ready');
  assert.equal(await stockLevel(header, shopId, stockItemId), 800);

  const voided = await request(app)
    .post(`/api/shops/${shopId}/orders/${order.id}/items/${pizzaItemId}/void`)
    .set('Authorization', header)
    .send({ wasPrepped: true });
  assert.equal(voided.status, 200);

  assert.equal(
    await stockLevel(header, shopId, stockItemId),
    800,
    'flag-only, no auto-reversal - the ingredients really were used'
  );
});

test('cancelling an order after a deduction does NOT restore its stock', async () => {
  const f = await shopWithLinkedRecipe();

  await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  const cancelled = await request(app)
    .post(`/api/shops/${f.shopId}/orders/${f.order.id}/cancel`)
    .set('Authorization', f.header)
    .send({ wasPrepped: true });

  assert.equal(cancelled.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
});

// --- 10.2's guards still hold, and nothing deducts through them ---

test('a cancelled order still blocks the status update and deducts nothing', async () => {
  const f = await shopWithLinkedRecipe();

  await request(app)
    .post(`/api/shops/${f.shopId}/orders/${f.order.id}/cancel`)
    .set('Authorization', f.header)
    .send({ wasPrepped: false });

  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');

  assert.equal(res.status, 400);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 1000, 'no stock moved');
  assert.equal(await deductedAt(f.orderItemId), null);
});

// --- The response contract is unchanged by 10.3 ---

test('the deduction is invisible in the response - no new fields, same totals', async () => {
  const f = await shopWithLinkedRecipe();
  const before = f.order.items[0];

  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  const after = res.body.items.find((i) => i.id === f.orderItemId);

  assert.equal(res.status, 200);
  assert.equal(after.status, 'ready');
  // The kitchen-facing fields are intact and match the created order.
  assert.equal(after.itemName, before.itemName);
  assert.equal(after.quantity, before.quantity);
  // No inventory detail leaks through this VIEW_KDS-gated route - the whole
  // point of 10.3 adding no response field at all.
  assert.equal(after.inventoryDeductedAt, undefined);
  assert.equal(after.deducted, undefined);
  assert.equal(res.body.deducted, undefined);
  assert.equal(res.body.skipped, undefined);
  // ...and, since the 10.2 leak fix, no monetary detail either. (This test
  // previously asserted unitPrice/subtotal/total came back unchanged; that
  // was the leak, not the contract - see kdsOrderView.js.)
  assert.equal(after.unitPrice, undefined);
  assert.equal(res.body.subtotal, undefined);
  assert.equal(res.body.total, undefined);
});

// --- Actor coverage ---

test('a Chef marking an item ready deducts stock just as an owner does', async () => {
  const f = await shopWithLinkedRecipe();
  const chef = await insertStaff(f.shopId, 'chef');
  const chefHeader = await staffHeaderFor(f.shopId, chef.staffIdCode);

  const res = await setStatus(chefHeader, f.shopId, f.order.id, f.orderItemId, 'ready');

  assert.equal(res.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
});

test('a Server without VIEW_KDS cannot trigger a deduction', async () => {
  const f = await shopWithLinkedRecipe();
  const server = await insertStaff(f.shopId, 'server');
  const serverHeader = await staffHeaderFor(f.shopId, server.staffIdCode);

  const res = await setStatus(serverHeader, f.shopId, f.order.id, f.orderItemId, 'ready');

  assert.equal(res.status, 403);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 1000);
  assert.equal(await deductedAt(f.orderItemId), null);
});

// --- Cross-module: paying does not deduct, only the KDS event does ---

test('taking payment does not deduct - 10.3 owns the trigger, not 9.5', async () => {
  const f = await shopWithLinkedRecipe();

  const paid = await request(app)
    .post(`/api/shops/${f.shopId}/orders/${f.order.id}/payments`)
    .set('Authorization', f.header)
    .send({ method: 'cash', amountTendered: 10 });

  assert.equal(paid.status, 201);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 1000, 'payment moves no stock');

  // ...and the kitchen can still mark it ready afterward, which DOES deduct
  // (10.2 deliberately does not block prep on a paid order).
  const res = await setStatus(f.header, f.shopId, f.order.id, f.orderItemId, 'ready');
  assert.equal(res.status, 200);
  assert.equal(await stockLevel(f.header, f.shopId, f.stockItemId), 800);
});

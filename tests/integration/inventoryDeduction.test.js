import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { deductInventoryForSale } from '../../src/modules/inventory/saleDeduction.service.js';

/**
 * 7.9's engine has no HTTP route (nothing triggers a deduction until
 * Modules 9/10 exist), so these tests call the service function directly.
 * Setup still goes through the real API so the data is built exactly the
 * way a real caller would build it.
 */

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('deduction-owner'), passwordHash]
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
      name: `Deduction Test Ltd ${crypto.randomUUID()}`,
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
  return { userId, header, shopId: shopRes.body.id };
}

async function createCategory(header, name) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name });
  return res.body.id;
}

async function createMenuItem(header, categoryId, name) {
  const res = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId, name, price: 9.99 });
  return res.body.id;
}

async function createVariant(header, itemId, name) {
  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${itemId}/variants`)
    .set('Authorization', header)
    .send({ name, price: 12.99 });
  return res.body.id;
}

async function createIngredient(header, name, unit) {
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

async function attachIngredientToVariant(header, itemId, variantId, ingredientId, quantity) {
  await request(app)
    .post(
      `/api/companies/mine/menu-items/${itemId}/variants/${variantId}/ingredients/${ingredientId}`
    )
    .set('Authorization', header)
    .send({ quantity });
}

async function createModifierOptionWithIngredient(header, ingredientId, quantity) {
  const groupRes = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: `Extras ${crypto.randomUUID()}` });
  const groupId = groupRes.body.id;
  const optionRes = await request(app)
    .post(`/api/companies/mine/modifier-groups/${groupId}/options`)
    .set('Authorization', header)
    .send({ name: 'Extra Cheese', priceDelta: 1 });
  const optionId = optionRes.body.id;
  await request(app)
    .post(
      `/api/companies/mine/modifier-groups/${groupId}/options/${optionId}/ingredients/${ingredientId}`
    )
    .set('Authorization', header)
    .send({ quantity });
  return optionId;
}

async function createInventoryItem(header, shopId, data) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send(data);
  return res.body.id;
}

async function linkIngredient(header, shopId, itemId, ingredientId, conversionFactor) {
  await request(app)
    .post(`/api/shops/${shopId}/inventory-items/${itemId}/ingredient-links/${ingredientId}`)
    .set('Authorization', header)
    .send(conversionFactor === undefined ? {} : { conversionFactor });
}

async function stockLevel(header, shopId, itemId) {
  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}`)
    .set('Authorization', header);
  return res.body.quantityOnHand;
}

// --- Core deduction ---

test('a simple sale deducts the recipe quantity from linked stock', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const ingredientId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, ingredientId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, ingredientId, 1);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  assert.equal(result.skipped.length, 0);
  assert.equal(result.deducted.length, 1);
  assert.equal(result.deducted[0].deductedQuantity, 200);
  assert.equal(await stockLevel(header, shopId, stockItemId), 800);
});

test('the conversion factor is applied (recipe in grams, stock in kg)', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const ingredientId = await createIngredient(header, 'Flour', 'g');
  await attachIngredientToItem(header, menuItemId, ingredientId, 250);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'kg',
    quantityOnHand: 25,
  });
  // 1 g of recipe flour = 0.001 kg of stock
  await linkIngredient(header, shopId, stockItemId, ingredientId, 0.001);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 2 }]);

  // 250g x 2 = 500g = 0.5kg
  assert.equal(result.deducted[0].requiredQuantity, 500);
  assert.equal(result.deducted[0].deductedQuantity, 0.5);
  assert.equal(await stockLevel(header, shopId, stockItemId), 24.5);
});

test('line quantity multiplies the recipe', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const ingredientId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, ingredientId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, ingredientId, 1);

  await deductInventoryForSale(shopId, [{ menuItemId, quantity: 3 }]);

  assert.equal(await stockLevel(header, shopId, stockItemId), 400);
});

// --- Variants and modifiers (both ADD to the base recipe) ---

test('a variant recipe ADDS to the base item recipe rather than replacing it', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const variantId = await createVariant(header, menuItemId, 'Large');
  const ingredientId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, ingredientId, 200);
  await attachIngredientToVariant(header, menuItemId, variantId, ingredientId, 100);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, ingredientId, 1);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, variantId, quantity: 1 }]);

  // 200 base + 100 variant = 300, NOT 100 (replace) and NOT 200 (base only)
  assert.equal(result.deducted[0].deductedQuantity, 300);
  assert.equal(await stockLevel(header, shopId, stockItemId), 700);
});

test('modifier option ingredients are added on top', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  const cheeseId = await createIngredient(header, 'Cheese', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);
  const optionId = await createModifierOptionWithIngredient(header, cheeseId, 50);

  const doughStockId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  const cheeseStockId = await createInventoryItem(header, shopId, {
    name: 'Cheese Stock',
    unit: 'g',
    quantityOnHand: 500,
  });
  await linkIngredient(header, shopId, doughStockId, doughId, 1);
  await linkIngredient(header, shopId, cheeseStockId, cheeseId, 1);

  await deductInventoryForSale(shopId, [
    { menuItemId, modifierOptionIds: [optionId], quantity: 2 },
  ]);

  assert.equal(await stockLevel(header, shopId, doughStockId), 600);
  assert.equal(await stockLevel(header, shopId, cheeseStockId), 400);
});

// --- The aggregation correctness case (verified empirically before coding) ---

test('two ingredients mapping to the SAME stock item aggregate into one correct deduction', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  // Two distinct recipe ingredients that both draw on one physical sack
  const doughFlourId = await createIngredient(header, 'Dough Flour', 'g');
  const dustingFlourId = await createIngredient(header, 'Dusting Flour', 'g');
  await attachIngredientToItem(header, menuItemId, doughFlourId, 200);
  await attachIngredientToItem(header, menuItemId, dustingFlourId, 50);

  const flourStockId = await createInventoryItem(header, shopId, {
    name: 'Flour Sack',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, flourStockId, doughFlourId, 1);
  await linkIngredient(header, shopId, flourStockId, dustingFlourId, 1);

  await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  // 1000 - (200 + 50) = 750. Without JS-side pre-aggregation, Postgres's
  // UPDATE...FROM unnest() would apply only ONE of the two deltas and
  // silently drop the other, landing on 800 or 950.
  assert.equal(await stockLevel(header, shopId, flourStockId), 750);
});

test('the same ingredient across two separate sale lines aggregates correctly', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const pizzaId = await createMenuItem(header, categoryId, 'Pizza');
  const calzoneId = await createMenuItem(header, categoryId, 'Calzone');
  const doughId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, pizzaId, doughId, 200);
  await attachIngredientToItem(header, calzoneId, doughId, 150);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, doughId, 1);

  await deductInventoryForSale(shopId, [
    { menuItemId: pizzaId, quantity: 1 },
    { menuItemId: calzoneId, quantity: 2 },
  ]);

  // 1000 - (200 + 300) = 500
  assert.equal(await stockLevel(header, shopId, stockItemId), 500);
});

// --- Unlinked ingredients ---

test('an unlinked ingredient is skipped and reported, without blocking the rest', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  const oreganoId = await createIngredient(header, 'Oregano', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);
  await attachIngredientToItem(header, menuItemId, oreganoId, 5);

  const doughStockId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  // Oregano deliberately NOT linked to any stock item
  await linkIngredient(header, shopId, doughStockId, doughId, 1);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].ingredientId, oreganoId);
  assert.equal(result.skipped[0].reason, 'not_linked');
  assert.equal(result.skipped[0].requiredQuantity, 5);
  // The linked one still went through
  assert.equal(result.deducted.length, 1);
  assert.equal(await stockLevel(header, shopId, doughStockId), 800);
});

test('an ingredient linked to a since-deleted stock item is reported as unlinked', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, doughId, 1);
  await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${stockItemId}`)
    .set('Authorization', header);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  assert.equal(result.deducted.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'not_linked');
});

// --- Insufficient stock ---

test('deduction goes negative rather than blocking - the sale already happened', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 100,
  });
  await linkIngredient(header, shopId, stockItemId, doughId, 1);

  const result = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  assert.equal(result.skipped.length, 0);
  // 100 - 200 = -100, deliberately NOT a 409 like 7.7's wastage
  assert.equal(await stockLevel(header, shopId, stockItemId), -100);
});

// --- Repeated calls / edge cases ---

test('repeated deductions accumulate rather than overwrite', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);

  const stockItemId = await createInventoryItem(header, shopId, {
    name: 'Dough Stock',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopId, stockItemId, doughId, 1);

  await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);
  await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);
  await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);

  assert.equal(await stockLevel(header, shopId, stockItemId), 400);
});

test('an empty sale, and a menu item with no recipe, both deduct nothing', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Plain Item');

  const emptyResult = await deductInventoryForSale(shopId, []);
  assert.deepEqual(emptyResult, { deducted: [], skipped: [] });

  const noRecipeResult = await deductInventoryForSale(shopId, [{ menuItemId, quantity: 1 }]);
  assert.deepEqual(noRecipeResult, { deducted: [], skipped: [] });
});

test('a sale line only affects the shop it was sold in', async () => {
  const { header, shopId: shopAId } = await setupOwnerWithShop();
  const shopBRes = await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({
      name: 'Second Shop',
      addressLine1: '3 Market St',
      city: 'London',
      postcode: 'E1 2AA',
      country: 'UK',
      phone: '02011113333',
      vatRegistered: true,
    });
  const shopBId = shopBRes.body.id;

  const categoryId = await createCategory(header, 'Mains');
  const menuItemId = await createMenuItem(header, categoryId, 'Pizza');
  const doughId = await createIngredient(header, 'Dough', 'g');
  await attachIngredientToItem(header, menuItemId, doughId, 200);

  const stockAId = await createInventoryItem(header, shopAId, {
    name: 'Dough Stock A',
    unit: 'g',
    quantityOnHand: 1000,
  });
  const stockBId = await createInventoryItem(header, shopBId, {
    name: 'Dough Stock B',
    unit: 'g',
    quantityOnHand: 1000,
  });
  await linkIngredient(header, shopAId, stockAId, doughId, 1);
  await linkIngredient(header, shopBId, stockBId, doughId, 1);

  await deductInventoryForSale(shopAId, [{ menuItemId, quantity: 1 }]);

  assert.equal(await stockLevel(header, shopAId, stockAId), 800);
  assert.equal(await stockLevel(header, shopBId, stockBId), 1000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { enablePaymentMethod } from '../helpers/billing.js';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('receiving-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithShop() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Receiving Test Ltd',
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

async function createSupplier(header, shopId, name = 'Bidfood') {
  const res = await request(app)
    .post(`/api/shops/${shopId}/suppliers`)
    .set('Authorization', header)
    .send({ name });
  return res.body;
}

async function createItem(header, shopId, name, initialQuantity = 0) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/inventory-items`)
    .set('Authorization', header)
    .send({ name, unit: 'kg', quantityOnHand: initialQuantity });
  return res.body;
}

async function getItem(header, shopId, itemId) {
  const res = await request(app)
    .get(`/api/shops/${shopId}/inventory-items/${itemId}`)
    .set('Authorization', header);
  return res.body;
}

async function createPo(header, shopId, supplierId, lineItems) {
  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header)
    .send({ supplierId, items: lineItems });
  return res.body;
}

// --- Full receipt, exact quantities, stock actually updates ---

test('POST a receipt with exact quantities increments quantityOnHand and shows no discrepancy', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 5);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10, unitCost: 2 },
  ]);
  const poItemId = po.items[0].id;

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 10 }] });

  assert.equal(res.status, 201);
  const item = res.body.items[0];
  assert.equal(item.orderedQuantity, 10);
  assert.equal(item.receivedQuantity, 10);
  assert.equal(item.discrepancy, 0);
  assert.equal(item.hasDiscrepancy, false);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 15); // 5 initial + 10 received
});

// --- Partial receipts across multiple deliveries ---

test('two partial receipts against the same line item accumulate correctly, both in receivedQuantity and in stock', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10 },
  ]);
  const poItemId = po.items[0].id;

  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 6 }] });

  const secondRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 4 }] });

  assert.equal(secondRes.status, 201);
  const item = secondRes.body.items[0];
  assert.equal(item.receivedQuantity, 10); // 6 + 4
  assert.equal(item.discrepancy, 0);
  assert.equal(secondRes.body.receipts.length, 2);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 10); // 0 + 6 + 4
});

// --- Discrepancy: under and over delivery ---

test('under-delivery is flagged with a negative discrepancy, and stock only reflects what actually arrived', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10 },
  ]);
  const poItemId = po.items[0].id;

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 7 }] });

  const item = res.body.items[0];
  assert.equal(item.discrepancy, -3);
  assert.equal(item.hasDiscrepancy, true);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 7); // only what actually arrived
});

test('over-delivery is allowed (not blocked) and flagged with a positive discrepancy', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10 },
  ]);
  const poItemId = po.items[0].id;

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 12 }] });

  assert.equal(res.status, 201); // not blocked
  const item = res.body.items[0];
  assert.equal(item.discrepancy, 2);
  assert.equal(item.hasDiscrepancy, true);

  const stockAfter = await getItem(header, shopId, chicken.id);
  assert.equal(stockAfter.quantityOnHand, 12);
});

// --- Multi-item receipt ---

test('a receipt covering two different line items increments both items independently', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const flour = await createItem(header, shopId, 'Flour', 20);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10 },
    { inventoryItemId: flour.id, quantity: 5 },
  ]);
  const chickenPoItem = po.items.find((i) => i.itemName === 'Chicken Breast');
  const flourPoItem = po.items.find((i) => i.itemName === 'Flour');

  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({
      items: [
        { purchaseOrderItemId: chickenPoItem.id, quantityReceived: 10 },
        { purchaseOrderItemId: flourPoItem.id, quantityReceived: 5 },
      ],
    });

  const chickenStock = await getItem(header, shopId, chicken.id);
  const flourStock = await getItem(header, shopId, flour.id);
  assert.equal(chickenStock.quantityOnHand, 10);
  assert.equal(flourStock.quantityOnHand, 25); // 20 + 5
});

// --- Validation ---

test('a receipt line referencing a purchase_order_item from another PO returns 404', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const flour = await createItem(header, shopId, 'Flour', 0);
  const poA = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  const poB = await createPo(header, shopId, supplier.id, [{ inventoryItemId: flour.id, quantity: 5 }]);
  const poBItemId = poB.items[0].id;

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${poA.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poBItemId, quantityReceived: 5 }] });

  assert.equal(res.status, 404);
});

test('a receipt with a duplicate purchaseOrderItemId is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  const poItemId = po.items[0].id;

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({
      items: [
        { purchaseOrderItemId: poItemId, quantityReceived: 5 },
        { purchaseOrderItemId: poItemId, quantityReceived: 3 },
      ],
    });

  assert.equal(res.status, 400);
});

test('a receipt with no line items is rejected', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [] });

  assert.equal(res.status, 400);
});

test('receipts against a purchase order from another shop returns 404', async () => {
  const ownerA = await setupOwnerWithShop();
  const supplierA = await createSupplier(ownerA.header, ownerA.shopId);
  const itemA = await createItem(ownerA.header, ownerA.shopId, 'Chicken Breast', 0);
  const poA = await createPo(ownerA.header, ownerA.shopId, supplierA.id, [
    { inventoryItemId: itemA.id, quantity: 10 },
  ]);
  const ownerB = await setupOwnerWithShop();

  const res = await request(app)
    .post(`/api/shops/${ownerB.shopId}/purchase-orders/${poA.id}/receipts`)
    .set('Authorization', ownerB.header)
    .send({ items: [{ purchaseOrderItemId: poA.items[0].id, quantityReceived: 5 }] });

  assert.equal(res.status, 404);
});

test('receipts have no delete endpoint - they are immutable once created', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  const receiptRes = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 10 }] });
  const receiptId = receiptRes.body.receipts[0].id;

  const res = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts/${receiptId}`)
    .set('Authorization', header);

  assert.equal(res.status, 404); // no route registered
});
// --- Deleting a PO once it has been received against ---

/**
 * Receiving is this module's one write path that mutates real stock, and
 * receipts are immutable. Deleting the PO afterwards would leave that stock
 * with nothing explaining it and hide the receipts behind a parent that 404s.
 */
test('a purchase order that has been received against cannot be deleted', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 5);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 10 }] });

  const res = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /already been received/i);
});

test('a rejected delete leaves the PO, its receipts, and the received stock intact', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 5);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 10 }] });

  await request(app).delete(`/api/shops/${shopId}/purchase-orders/${po.id}`).set('Authorization', header);

  const getRes = await request(app)
    .get(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.receipts.length, 1); // receipt history still reachable

  const listRes = await request(app)
    .get(`/api/shops/${shopId}/purchase-orders`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 1); // still listed, not soft-deleted

  const stock = await getItem(header, shopId, chicken.id);
  assert.equal(stock.quantityOnHand, 15); // 5 initial + 10 received, untouched
});

/** A PO with nothing received is still just a record of intent - deletable. */
test('a purchase order with no receipts can still be deleted', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 5);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});

/** Partial delivery still counts - stock moved, so the PO is locked. */
test('even a partial receipt locks the purchase order against deletion', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 3 }] });

  const res = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

/**
 * The guard reads purchase_orders.first_received_at rather than counting
 * receipts, so a PO whose receipts predate that column must still be
 * protected. This simulates one by clearing the stamp the way a pre-migration
 * row would look, and asserts the backfill query in
 * 1789425350316_add-first-received-at-to-purchase-orders repairs it.
 */
test('the migration backfill protects purchase orders received before the column existed', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: po.items[0].id, quantityReceived: 10 }] });

  // Simulate the pre-migration state: receipts exist, stamp does not.
  await query(`UPDATE purchase_orders SET first_received_at = NULL WHERE id = $1`, [po.id]);

  // Re-run the migration's backfill.
  await query(`
    UPDATE purchase_orders po
    SET first_received_at = r.first_received_at
    FROM (
      SELECT purchase_order_id, min(received_at) AS first_received_at
      FROM purchase_order_receipts GROUP BY purchase_order_id
    ) r
    WHERE r.purchase_order_id = po.id
  `);

  const res = await request(app)
    .delete(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

/** A second delivery must not move the recorded first-arrival time. */
test('a later partial receipt does not overwrite the first arrival time', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 0);
  const po = await createPo(header, shopId, supplier.id, [{ inventoryItemId: chicken.id, quantity: 10 }]);
  const poItemId = po.items[0].id;

  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 4 }] });
  const { rows: first } = await query(
    `SELECT first_received_at FROM purchase_orders WHERE id = $1`,
    [po.id]
  );

  await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 6 }] });
  const { rows: second } = await query(
    `SELECT first_received_at FROM purchase_orders WHERE id = $1`,
    [po.id]
  );

  assert.deepEqual(second[0].first_received_at, first[0].first_received_at);
});

// --- TOCTOU: inventory item soft-deleted after the PO was created ---

/**
 * adjustInventoryQuantities has no deleted_at filter, so without a pre-write
 * check a receipt could silently add stock to a row no other read/update
 * endpoint can reach again. createReceipt must validate every referenced
 * inventory item is still active BEFORE writing the receipt or touching stock.
 */
test('receiving against a line whose inventory item was soft-deleted after the PO was created returns 404 and leaves stock unchanged', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  const supplier = await createSupplier(header, shopId);
  const chicken = await createItem(header, shopId, 'Chicken Breast', 5);
  const po = await createPo(header, shopId, supplier.id, [
    { inventoryItemId: chicken.id, quantity: 10 },
  ]);
  const poItemId = po.items[0].id;

  const deleteRes = await request(app)
    .delete(`/api/shops/${shopId}/inventory-items/${chicken.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const res = await request(app)
    .post(`/api/shops/${shopId}/purchase-orders/${po.id}/receipts`)
    .set('Authorization', header)
    .send({ items: [{ purchaseOrderItemId: poItemId, quantityReceived: 10 }] });

  assert.equal(res.status, 404);

  const { rows } = await query(
    `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
    [chicken.id]
  );
  assert.equal(Number(rows[0].quantity_on_hand), 5); // unchanged - no write occurred

  const receiptsRes = await request(app)
    .get(`/api/shops/${shopId}/purchase-orders/${po.id}`)
    .set('Authorization', header);
  assert.equal(receiptsRes.body.receipts.length, 0); // no receipt row was created either
});

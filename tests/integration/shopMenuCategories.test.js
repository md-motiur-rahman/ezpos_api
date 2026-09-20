import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { enablePaymentMethod } from '../helpers/billing.js';

const KNOWN_PIN = '12345678';

function uniqueEmail(label) {
  return `${label}-${crypto.randomUUID()}@example.com`;
}

async function insertUser() {
  const passwordHash = await bcrypt.hash('irrelevant-password', 4); // low cost - tests only
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, full_name, email_verified_at)
     VALUES ($1, $2, 'Test Owner', now()) RETURNING id`,
    [uniqueEmail('menucat-owner'), passwordHash]
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
      name: 'Menu Category Test Ltd',
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
  return { userId, header, shopId: shopRes.body.id };
}

async function createCategory(header, name, displayOrder) {
  const res = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name, displayOrder });
  return res.body;
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

// GET /api/shops/:shopId/menu/categories - added alongside Module 13/14 so a
// staff actor (no route to the owner-only GET /api/companies/mine/menu-
// categories) can still label a resolved-menu item's bare categoryId.

test('an owner reads category names through the shop-scoped route', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createCategory(header, 'THE JUICES', 1);
  await createCategory(header, 'THE SHAKES', 2);

  const res = await request(app).get(`/api/shops/${shopId}/menu/categories`).set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(
    res.body.map((c) => c.name),
    ['THE JUICES', 'THE SHAKES']
  );
  // Deliberately narrow response shape - no companyId/isActive/timestamps,
  // a till has no use for the owner-management fields.
  assert.deepEqual(Object.keys(res.body[0]).sort(), ['displayOrder', 'id', 'name']);
});

test('a Server (no manage_menu) can still read category names', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createCategory(header, 'Mains', 0);
  const server = await insertStaff(shopId, 'server');
  const serverHeader = await staffHeaderFor(shopId, server.staffIdCode);

  const res = await request(app)
    .get(`/api/shops/${shopId}/menu/categories`)
    .set('Authorization', serverHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body[0].name, 'Mains');
});

test('a Chef can also read category names - PERFORM_HEALTH_SAFETY-style broad read, no permission gate at all', async () => {
  const { header, shopId } = await setupOwnerWithShop();
  await createCategory(header, 'Mains', 0);
  const chef = await insertStaff(shopId, 'chef');
  const chefHeader = await staffHeaderFor(shopId, chef.staffIdCode);

  const res = await request(app).get(`/api/shops/${shopId}/menu/categories`).set('Authorization', chefHeader);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test('categories from a different company never leak into this shop\'s list', async () => {
  const { header: ownHeader, shopId } = await setupOwnerWithShop();
  await createCategory(ownHeader, 'Our Category', 0);
  const { header: otherHeader } = await setupOwnerWithShop();
  await createCategory(otherHeader, 'Someone Else\'s Category', 0);

  const res = await request(app).get(`/api/shops/${shopId}/menu/categories`).set('Authorization', ownHeader);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((c) => c.name),
    ['Our Category']
  );
});

test('an unknown shopId 404s, same tenancy-boundary shape as every other shop-scoped route', async () => {
  const { header } = await setupOwnerWithShop();

  const res = await request(app)
    .get(`/api/shops/${crypto.randomUUID()}/menu/categories`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});

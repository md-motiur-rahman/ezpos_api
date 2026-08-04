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
    [uniqueEmail('modifier-owner'), passwordHash]
  );
  return rows[0].id;
}

function headerFor(userId) {
  return `Bearer ${signAccessToken({ id: userId, email: 'irrelevant@example.com' })}`;
}

async function setupOwnerWithCompany() {
  const userId = await insertUser();
  const header = headerFor(userId);
  await request(app)
    .post('/api/companies')
    .set('Authorization', header)
    .send({
      name: 'Modifier Test Ltd',
      addressLine1: '1 High Street',
      city: 'London',
      postcode: 'SW1A 1AA',
      country: 'UK',
      phone: '02012345678',
    });
  return { userId, header };
}

async function createGroup(header, overrides = {}) {
  const res = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: 'Choose your sauce', minSelections: 1, maxSelections: 1, ...overrides });
  return res.body;
}

async function createCategoryAndItem(header) {
  const category = await request(app)
    .post('/api/companies/mine/menu-categories')
    .set('Authorization', header)
    .send({ name: 'Mains' });
  const item = await request(app)
    .post('/api/companies/mine/menu-items')
    .set('Authorization', header)
    .send({ categoryId: category.body.id, name: 'Chicken Wrap', price: 5.99 });
  return item.body;
}

// --- Group CRUD ---

test('POST modifier-groups creates a group', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: 'Choose your sauce', minSelections: 1, maxSelections: 1 });

  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Choose your sauce');
  assert.equal(res.body.minSelections, 1);
  assert.equal(res.body.maxSelections, 1);
});

test('POST modifier-groups rejects minSelections greater than maxSelections', async () => {
  const { header } = await setupOwnerWithCompany();

  const res = await request(app)
    .post('/api/companies/mine/modifier-groups')
    .set('Authorization', header)
    .send({ name: 'Broken', minSelections: 3, maxSelections: 1 });

  assert.equal(res.status, 400);
});

test('GET modifier-groups lists groups for the company', async () => {
  const { header } = await setupOwnerWithCompany();
  await createGroup(header, { name: 'Sauces' });
  await createGroup(header, { name: 'Extras' });

  const res = await request(app)
    .get('/api/companies/mine/modifier-groups')
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('PATCH modifier-groups updates name and selection bounds', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);

  const res = await request(app)
    .patch(`/api/companies/mine/modifier-groups/${group.id}`)
    .set('Authorization', header)
    .send({ name: 'Pick a sauce', maxSelections: 2 });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Pick a sauce');
  assert.equal(res.body.maxSelections, 2);
});

test('a group from another company returns 404', async () => {
  const ownerA = await setupOwnerWithCompany();
  const groupA = await createGroup(ownerA.header);
  const ownerB = await setupOwnerWithCompany();

  const res = await request(app)
    .patch(`/api/companies/mine/modifier-groups/${groupA.id}`)
    .set('Authorization', ownerB.header)
    .send({ name: 'Hijacked' });

  assert.equal(res.status, 404);
});

// --- Delete-blocked-by-options rule (mirrors 6.1's categories) ---

test('a group with options cannot be deleted - 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);
  await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Ketchup', priceDelta: 0 });

  const res = await request(app)
    .delete(`/api/companies/mine/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

test('a group can be deleted once all its options are deleted', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);
  const option = await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Ketchup', priceDelta: 0 });

  await request(app)
    .delete(`/api/companies/mine/modifier-groups/${group.id}/options/${option.body.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .delete(`/api/companies/mine/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
});

// --- Option CRUD ---

test('POST options creates an option, price_delta can be negative', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);

  const res = await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'No Sauce', priceDelta: -0.5 });

  assert.equal(res.status, 201);
  assert.equal(res.body.priceDelta, -0.5);
});

test('POST options with priceDelta 0 is valid (a free swap)', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);

  const res = await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Sweet Chilli Sauce', priceDelta: 0 });

  assert.equal(res.status, 201);
  assert.equal(res.body.priceDelta, 0);
});

test('GET options lists all options for a group', async () => {
  const { header } = await setupOwnerWithCompany();
  const group = await createGroup(header);
  await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Ketchup', priceDelta: 0 });
  await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Sweet Chilli Sauce', priceDelta: 0 });

  const res = await request(app)
    .get(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('an option from another group returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const groupA = await createGroup(header, { name: 'Sauces' });
  const groupB = await createGroup(header, { name: 'Extras' });
  const option = await request(app)
    .post(`/api/companies/mine/modifier-groups/${groupA.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Ketchup', priceDelta: 0 });

  const res = await request(app)
    .patch(`/api/companies/mine/modifier-groups/${groupB.id}/options/${option.body.id}`)
    .set('Authorization', header)
    .send({ priceDelta: 1 });

  assert.equal(res.status, 404);
});

// --- Attach / detach to a master item ---

test('POST attaches a modifier group to an item', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const group = await createGroup(header);

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 201);
});

test('attaching the same group twice returns 409', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const group = await createGroup(header);
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 409);
});

test('GET item modifier-groups returns the attached group with its options', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const group = await createGroup(header);
  await request(app)
    .post(`/api/companies/mine/modifier-groups/${group.id}/options`)
    .set('Authorization', header)
    .send({ name: 'Ketchup', priceDelta: 0 });
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const res = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/modifier-groups`)
    .set('Authorization', header);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
  assert.equal(res.body[0].id, group.id);
  assert.equal(res.body[0].options.length, 1);
  assert.equal(res.body[0].options[0].name, 'Ketchup');
});

test('DELETE detaches a modifier group from an item', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const group = await createGroup(header);
  await request(app)
    .post(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  const deleteRes = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);
  assert.equal(deleteRes.status, 200);

  const listRes = await request(app)
    .get(`/api/companies/mine/menu-items/${item.id}/modifier-groups`)
    .set('Authorization', header);
  assert.equal(listRes.body.length, 0);
});

test('detaching a group that is not attached returns 404', async () => {
  const { header } = await setupOwnerWithCompany();
  const item = await createCategoryAndItem(header);
  const group = await createGroup(header);

  const res = await request(app)
    .delete(`/api/companies/mine/menu-items/${item.id}/modifier-groups/${group.id}`)
    .set('Authorization', header);

  assert.equal(res.status, 404);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import app from '../../src/app.js';
import { query } from '../../src/db/pool.js';
import { signAccessToken } from '../../src/utils/jwt.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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

const VALID_SHOP = {
  name: 'Test Shop',
  addressLine1: '2 Market Street',
  city: 'London',
  postcode: 'E1 1AA',
  country: 'UK',
  phone: '02011112222',
  vatRegistered: true,
};

async function setupCompany(businessType) {
  const userId = await insertUser();
  const header = authHeaderFor(userId);
  await request(app).post('/api/companies').set('Authorization', header).send(VALID_COMPANY);
  await request(app)
    .post('/api/companies/mine/business-type')
    .set('Authorization', header)
    .send({ businessType });
  return { userId, header };
}

async function trialEndsAt(userId) {
  const { rows } = await query(
    `SELECT trial_ends_at FROM companies WHERE owner_user_id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  return rows[0].trial_ends_at;
}

test('a company has no trial_ends_at before its first shop exists', async () => {
  const { userId } = await setupCompany('single');

  assert.equal(await trialEndsAt(userId), null);
});

test('creating the first ever shop sets trial_ends_at about 14 days out', async () => {
  const { userId, header } = await setupCompany('single');

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const endsAt = await trialEndsAt(userId);
  assert.ok(endsAt);
  const daysOut = (new Date(endsAt).getTime() - Date.now()) / DAY_MS;
  assert.ok(daysOut > 13.9 && daysOut < 14.1, `expected ~14 days, got ${daysOut}`);
});

test('GET /api/companies/mine exposes trialEndsAt', async () => {
  const { header } = await setupCompany('single');

  const before = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.equal(before.body.trialEndsAt, null);

  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);

  const after = await request(app).get('/api/companies/mine').set('Authorization', header);
  assert.ok(after.body.trialEndsAt);
});

test('adding a second shop does not change trial_ends_at', async () => {
  const { userId, header } = await setupCompany('chain');
  await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  const firstValue = await trialEndsAt(userId);

  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Second Shop' });

  assert.deepEqual(await trialEndsAt(userId), firstValue);
});

test('closing the last shop and opening a new one does NOT grant a second trial', async () => {
  const { userId, header } = await setupCompany('single');
  const first = await request(app).post('/api/shops').set('Authorization', header).send(VALID_SHOP);
  const originalTrial = await trialEndsAt(userId);

  // Closing the last shop cancels the subscription (3.2), so the next shop
  // creates a brand new one - which must not come with another free trial.
  await request(app).delete(`/api/shops/${first.body.id}`).set('Authorization', header);
  await request(app)
    .post('/api/shops')
    .set('Authorization', header)
    .send({ ...VALID_SHOP, name: 'Reopened Shop' });

  assert.deepEqual(await trialEndsAt(userId), originalTrial);
});
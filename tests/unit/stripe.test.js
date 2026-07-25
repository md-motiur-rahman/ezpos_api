import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeCustomer } from '../../src/utils/stripe.js';

test('createStripeCustomer returns a fake customer id in test env without a network call', async () => {
  const id = await createStripeCustomer({ email: 'a@example.com', name: 'Test Co', companyId: 'x' });

  assert.equal(typeof id, 'string');
  assert.ok(id.startsWith('cus_test_'));
});

test('createStripeCustomer returns a different id on each call', async () => {
  const first = await createStripeCustomer({ email: 'a@example.com', name: 'Test Co', companyId: 'x' });
  const second = await createStripeCustomer({ email: 'a@example.com', name: 'Test Co', companyId: 'x' });

  assert.notEqual(first, second);
});
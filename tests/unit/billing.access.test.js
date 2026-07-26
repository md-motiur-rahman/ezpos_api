import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBillingLocked } from '../../src/modules/billing/billing.access.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + DAY_MS);
const past = new Date(Date.now() - DAY_MS);

test('a company with no subscription status is not locked', () => {
  assert.equal(isBillingLocked({ subscription_status: null, grace_period_ends_at: null }), false);
});

test('an active subscription is not locked', () => {
  assert.equal(isBillingLocked({ subscription_status: 'active', grace_period_ends_at: null }), false);
});

test('a trialing subscription is not locked', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'trialing', grace_period_ends_at: null }),
    false
  );
});

test('past_due inside an unexpired grace period is not locked', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'past_due', grace_period_ends_at: future }),
    false
  );
});

test('past_due after the grace period has expired is locked', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'past_due', grace_period_ends_at: past }),
    true
  );
});

test('past_due with no grace period recorded is not locked (safer failure mode)', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'past_due', grace_period_ends_at: null }),
    false
  );
});

test('canceled is locked regardless of grace period', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'canceled', grace_period_ends_at: future }),
    true
  );
});

test('unpaid is locked regardless of grace period', () => {
  assert.equal(
    isBillingLocked({ subscription_status: 'unpaid', grace_period_ends_at: future }),
    true
  );
});
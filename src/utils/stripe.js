import Stripe from 'stripe';
import crypto from 'node:crypto';
import config from '../config/index.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

// The client is constructed in every environment, including tests. Every
// function that makes a real network call guards on config.env.isTest and
// returns a fake instead, so nothing reaches Stripe during tests. Webhook
// signature verification is the exception that needs a real client: it's
// pure local HMAC with no network call, so tests exercise the genuine
// cryptographic path rather than a stub.
const stripe = new Stripe(config.env.stripeSecretKey);

function fakeId(prefix) {
  return `${prefix}_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

/**
 * Creates a Stripe Customer record. Billing-neutral - creating a customer
 * has no cost and starts no subscription (that's createSubscriptionWithShop
 * below, since Stripe requires at least one priced line item to create a
 * Subscription).
 *
 * Unlike email sending, a failure here is NOT swallowed - billing setup
 * failing silently would be worse than a clear error, since the company
 * would otherwise have no way to ever be billed. Same applies to every
 * function in this file.
 */
export async function createStripeCustomer({ email, name, companyId }) {
  if (config.env.isTest) {
    return fakeId('cus');
  }

  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { companyId },
    });
    return customer.id;
  } catch (err) {
    logger.error({ err, companyId }, 'Failed to create Stripe customer');
    throw new AppError('Failed to set up billing for this company', 502);
  }
}

/**
 * Creates the company's subscription with its first shop as the first line
 * item. Stripe can't create a Subscription with zero items, which is why
 * this happens at first-shop time rather than at company setup (3.1).
 *
 * `trialDays` is only passed for a company's very first subscription - see
 * shop.service.js for why (closing all shops and reopening must not grant a
 * second free trial).
 *
 * Returns { subscriptionId, subscriptionItemId }.
 */
export async function createSubscriptionWithShop({ customerId, shopId, trialDays }) {
  if (config.env.isTest) {
    return { subscriptionId: fakeId('sub'), subscriptionItemId: fakeId('si') };
  }

  const params = {
    customer: customerId,
    items: [{ price: config.env.stripeShopPriceId, metadata: { shopId } }],
  };
  if (trialDays) {
    params.trial_period_days = trialDays;
  }

  try {
    const subscription = await stripe.subscriptions.create(params);
    return {
      subscriptionId: subscription.id,
      subscriptionItemId: subscription.items.data[0].id,
    };
  } catch (err) {
    logger.error({ err, customerId, shopId }, 'Failed to create Stripe subscription');
    throw new AppError('Failed to set up billing for this shop', 502);
  }
}

/**
 * Adds a line item to an existing subscription. Generic over what's being
 * billed - a shop (3.2) or a per-shop add-on (3.3) - the only difference is
 * which Price is used.
 */
export async function addSubscriptionItem({ subscriptionId, priceId, metadata }) {
  if (config.env.isTest) {
    return fakeId('si');
  }

  try {
    const item = await stripe.subscriptionItems.create({
      subscription: subscriptionId,
      price: priceId,
      metadata,
    });
    return item.id;
  } catch (err) {
    logger.error({ err, subscriptionId, priceId, metadata }, 'Failed to add subscription item');
    throw new AppError('Failed to update billing', 502);
  }
}

/**
 * Removes one line item (a shop or an add-on). proration_behavior 'none'
 * means no credit is issued for the remainder of the current period -
 * matching the agreed policy: no mid-cycle refunds, access continues until
 * the cycle ends.
 */
export async function removeSubscriptionItem({ subscriptionItemId }) {
  if (config.env.isTest) {
    return;
  }

  try {
    await stripe.subscriptionItems.del(subscriptionItemId, { proration_behavior: 'none' });
  } catch (err) {
    logger.error({ err, subscriptionItemId }, 'Failed to remove subscription item');
    throw new AppError('Failed to update billing', 502);
  }
}

/**
 * Used when closing a company's LAST shop. Deleting the final item on a
 * subscription is ambiguous in Stripe, so we cancel the whole subscription
 * instead - at period end, so the company keeps access until the cycle
 * they already paid for runs out.
 */
export async function cancelSubscriptionAtPeriodEnd({ subscriptionId }) {
  if (config.env.isTest) {
    return;
  }

  try {
    await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  } catch (err) {
    logger.error({ err, subscriptionId }, 'Failed to cancel Stripe subscription');
    throw new AppError('Failed to update billing for this company', 502);
  }
}

/**
 * Verifies a webhook actually came from Stripe and returns the parsed event.
 *
 * Requires the RAW request body - if Express's JSON parser has already turned
 * it into an object, the signature can never match (see app.js for why the
 * webhook route is mounted before express.json()).
 *
 * A failed check means either a misconfigured secret or a forged request, so
 * this is a 400 rather than a 502: the caller sent us something invalid.
 */
export function constructWebhookEvent({ rawBody, signature }) {
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, config.env.stripeWebhookSecret);
  } catch (err) {
    logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
    throw new AppError('Invalid webhook signature', 400);
  }
}
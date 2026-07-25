import Stripe from 'stripe';
import crypto from 'node:crypto';
import config from '../config/index.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

const stripe = config.env.isTest ? null : new Stripe(config.env.stripeSecretKey);

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
 * Returns { subscriptionId, subscriptionItemId }.
 *
 * NOTE (Module 3.4): the 14-day trial gets configured here, via
 * `trial_period_days` on this create call.
 */
export async function createSubscriptionWithShop({ customerId, shopId }) {
  if (config.env.isTest) {
    return { subscriptionId: fakeId('sub'), subscriptionItemId: fakeId('si') };
  }

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: config.env.stripeShopPriceId, metadata: { shopId } }],
    });
    return {
      subscriptionId: subscription.id,
      subscriptionItemId: subscription.items.data[0].id,
    };
  } catch (err) {
    logger.error({ err, customerId, shopId }, 'Failed to create Stripe subscription');
    throw new AppError('Failed to set up billing for this shop', 502);
  }
}

/** Adds another shop as a line item on the company's existing subscription. */
export async function addShopSubscriptionItem({ subscriptionId, shopId }) {
  if (config.env.isTest) {
    return fakeId('si');
  }

  try {
    const item = await stripe.subscriptionItems.create({
      subscription: subscriptionId,
      price: config.env.stripeShopPriceId,
      metadata: { shopId },
    });
    return item.id;
  } catch (err) {
    logger.error({ err, subscriptionId, shopId }, 'Failed to add shop subscription item');
    throw new AppError('Failed to set up billing for this shop', 502);
  }
}

/**
 * Removes one shop's line item. proration_behavior 'none' means no credit
 * is issued for the remainder of the current period - matching the agreed
 * policy: no mid-cycle refunds, access continues until the cycle ends.
 */
export async function removeShopSubscriptionItem({ subscriptionItemId }) {
  if (config.env.isTest) {
    return;
  }

  try {
    await stripe.subscriptionItems.del(subscriptionItemId, { proration_behavior: 'none' });
  } catch (err) {
    logger.error({ err, subscriptionItemId }, 'Failed to remove shop subscription item');
    throw new AppError('Failed to update billing for this shop', 502);
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
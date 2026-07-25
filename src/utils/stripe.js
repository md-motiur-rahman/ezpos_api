import Stripe from 'stripe';
import crypto from 'node:crypto';
import config from '../config/index.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

const stripe = config.env.isTest ? null : new Stripe(config.env.stripeSecretKey);

/**
 * Creates a Stripe Customer record. Billing-neutral - creating a customer
 * has no cost and starts no subscription (that's Module 3.2's job, since
 * Stripe requires at least one priced line item to create a Subscription).
 *
 * Unlike email sending, a failure here is NOT swallowed - billing setup
 * failing silently would be worse than a clear error, since the company
 * would otherwise have no way to ever be billed.
 */
export async function createStripeCustomer({ email, name, companyId }) {
  if (config.env.isTest) {
    return `cus_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
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
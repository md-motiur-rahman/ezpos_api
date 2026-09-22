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
 * Starts a hosted Stripe Checkout session in SETUP mode - it collects and
 * stores a card against the existing customer WITHOUT creating or touching a
 * subscription. Deliberately not mode: 'subscription': the trial and the
 * subscription's line items are already handled by
 * createSubscriptionWithShop, and routing them through Checkout instead would
 * mean two different places could create subscriptions.
 *
 * The card does NOT become the customer's default here - Stripe only records
 * it against the SetupIntent. Promoting it to the default is the
 * checkout.session.completed webhook's job (see billing.service.js), because
 * that is the only point at which the card is confirmed saved.
 */
export async function createSetupCheckoutSession({ customerId }) {
  if (config.env.isTest) {
    return { url: `https://checkout.stripe.com/test/${fakeId('cs')}`, id: fakeId('cs') };
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      success_url: `${config.env.frontendUrl}/billing?checkout=success`,
      cancel_url: `${config.env.frontendUrl}/billing?checkout=cancelled`,
    });
    return { url: session.url, id: session.id };
  } catch (err) {
    logger.error({ err, customerId }, 'Failed to create Stripe setup checkout session');
    throw new AppError('Failed to start payment method setup', 502);
  }
}

/**
 * Promotes the card just collected by a setup-mode Checkout session to the
 * customer's DEFAULT payment method, which is what subscription invoices
 * actually charge. Without this the card is stored but never used, and
 * renewals keep failing exactly as before.
 *
 * Returns the payment method id so the caller can record that a card now
 * exists. Throws rather than swallowing: the webhook must fail loudly and let
 * Stripe retry, or the company silently stays uncarded.
 */
export async function setDefaultPaymentMethodFromSetupIntent({ customerId, setupIntentId }) {
  if (config.env.isTest) {
    return fakeId('pm');
  }

  try {
    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: setupIntent.payment_method },
    });
    return setupIntent.payment_method;
  } catch (err) {
    logger.error({ err, customerId, setupIntentId }, 'Failed to set default payment method');
    throw new AppError('Failed to save payment method', 502);
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
 * Sets the ABSOLUTE quantity on an existing line item, which is how a
 * company's shop count (and each add-on's shop count) is actually billed:
 * one item per Price, quantity = how many active shops use it. Stripe
 * refuses a second item referencing a Price already on the subscription,
 * so quantity - not a new item - is the only way to bill the 2nd+ shop.
 *
 * Absolute rather than an increment/decrement on purpose: the caller passes
 * the count it just derived from the database, so the billed quantity is
 * recomputed from the source of truth every time and cannot drift the way a
 * running +1/-1 would if a call were ever lost or replayed.
 *
 * proration_behavior 'none' matches removeSubscriptionItem below: no
 * mid-cycle credit, no mid-cycle charge - the change lands at the next cycle.
 */
export async function setSubscriptionItemQuantity({ subscriptionItemId, quantity }) {
  if (config.env.isTest) {
    return;
  }

  try {
    await stripe.subscriptionItems.update(subscriptionItemId, {
      quantity,
      proration_behavior: 'none',
    });
  } catch (err) {
    logger.error({ err, subscriptionItemId, quantity }, 'Failed to set subscription item quantity');
    throw new AppError('Failed to update billing', 502);
  }
}

/**
 * Ends a subscription's trial right now instead of at its originally-granted
 * trial_end - Stripe's own documented mechanism for "stop the free period
 * early." The subscription transitions out of trialing immediately, and
 * Stripe generates and attempts to collect the subscription's normal period
 * invoice as of this moment, at whatever item quantities are on the
 * subscription AT THE TIME THIS CALL RUNS.
 *
 * That last part is load-bearing for the one caller this has today
 * (shop.service.js's createShop, "both shops billed together, starting
 * today" when a second shop is added mid-trial): the invoice this produces
 * only covers every shop if the quantity has ALREADY been raised to include
 * the new one before this runs. Callers must call
 * setSubscriptionItemQuantity (or addSubscriptionItem) first - this
 * function has no way to enforce that ordering itself, since it only ever
 * sees the subscription id, never the item being added.
 *
 * Whether the resulting charge actually succeeds is NOT something this call
 * waits for or reports - Stripe invoices and attempts payment
 * asynchronously, and the outcome arrives later via the existing
 * `invoice.payment_succeeded` / `invoice.payment_failed` /
 * `customer.subscription.updated` webhooks (billing.service.js), the exact
 * same path a normal renewal failure already goes through. A declined card
 * here does not fail the caller's own request or need special-casing - it
 * surfaces as an ordinary past_due + grace-period cycle, same as any other
 * failed invoice.
 */
export async function endTrialNow({ subscriptionId }) {
  if (config.env.isTest) {
    return;
  }

  try {
    await stripe.subscriptions.update(subscriptionId, { trial_end: 'now' });
  } catch (err) {
    logger.error({ err, subscriptionId }, 'Failed to end trial early');
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

/**
 * Fetches a company's invoice history directly from Stripe rather than our
 * own stripe_webhook_events table - that table only has what we chose to
 * record (amount, status, a timestamp). A real invoice number, a page the
 * owner can actually pay from (hostedInvoiceUrl), and a PDF only exist on
 * Stripe's side, and 3.6's lockout flow needs exactly that: something
 * actionable, not just "you owe some amount as of some date."
 *
 * Test mode returns a fixed canned pair (one paid, one open) rather than
 * random data - these tests are checking OUR integration (auth, company
 * resolution, response shaping), not re-testing Stripe's own list behaviour.
 */
export async function listInvoices({ customerId, limit }) {
  if (config.env.isTest) {
    return {
      invoices: [
        {
          id: 'in_test_paid_001',
          number: 'TEST-0001',
          status: 'paid',
          amountDue: 2999,
          amountPaid: 2999,
          currency: 'gbp',
          created: new Date('2026-06-01T00:00:00Z').toISOString(),
          hostedInvoiceUrl: 'https://invoice.stripe.com/test/paid',
          invoicePdf: 'https://invoice.stripe.com/test/paid.pdf',
        },
        {
          id: 'in_test_open_002',
          number: 'TEST-0002',
          status: 'open',
          amountDue: 2999,
          amountPaid: 0,
          currency: 'gbp',
          created: new Date('2026-07-01T00:00:00Z').toISOString(),
          hostedInvoiceUrl: 'https://invoice.stripe.com/test/open',
          invoicePdf: 'https://invoice.stripe.com/test/open.pdf',
        },
      ],
      hasMore: false,
    };
  }

  try {
    const result = await stripe.invoices.list({ customer: customerId, limit });
    return {
      invoices: result.data.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000).toISOString(),
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
      })),
      hasMore: result.has_more,
    };
  } catch (err) {
    logger.error({ err, customerId }, 'Failed to list Stripe invoices');
    throw new AppError('Failed to load billing history', 502);
  }
}
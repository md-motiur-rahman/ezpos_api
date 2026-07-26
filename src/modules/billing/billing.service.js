import { logger } from '../../utils/logger.js';
import * as companyRepository from '../company/company.repository.js';
import * as billingRepository from './billing.repository.js';

/** Event types we act on. Anything else is acknowledged and ignored. */
const HANDLED_EVENT_TYPES = new Set([
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Both invoice and subscription events carry the Stripe customer id, which is
 * how we map an event back to one of our companies. Returns null if we don't
 * recognise the customer - the event still gets recorded for audit purposes.
 */
async function findCompanyForEvent(event) {
  const stripeCustomerId = event.data?.object?.customer;
  if (!stripeCustomerId) {
    return null;
  }
  return companyRepository.findByStripeCustomerId(stripeCustomerId);
}

/**
 * Applies a verified Stripe event to our local state.
 *
 * Ordering matters here: state changes are applied BEFORE the event is
 * recorded. If we recorded first and the state change then failed, Stripe's
 * retry would be deduplicated away and the update lost permanently. Applying
 * first means a retry re-applies it, which is harmless because every state
 * change here is an idempotent status write.
 */
export async function handleWebhookEvent(event) {
  if (!HANDLED_EVENT_TYPES.has(event.type)) {
    // Stripe sends many event types we have no use for. Acknowledge without
    // recording, so the table stays a meaningful billing history rather than
    // a firehose log.
    return { handled: false };
  }

  const company = await findCompanyForEvent(event);
  const object = event.data.object;
  let amount = null;
  let status = null;

  switch (event.type) {
    case 'invoice.payment_succeeded':
      amount = object.amount_paid ?? null;
      status = 'succeeded';
      break;

    case 'invoice.payment_failed':
      amount = object.amount_due ?? null;
      status = 'failed';
      break;

    case 'customer.subscription.updated':
      if (company) {
        await companyRepository.setSubscriptionStatus(company.id, object.status);
      }
      break;

    case 'customer.subscription.deleted':
      if (company) {
        await companyRepository.setSubscriptionStatus(company.id, 'canceled');
      }
      break;
  }

  const recorded = await billingRepository.recordEvent({
    stripeEventId: event.id,
    eventType: event.type,
    companyId: company?.id ?? null,
    amount,
    status,
    occurredAt: event.created ? new Date(event.created * 1000) : null,
  });

  if (!recorded) {
    logger.info({ stripeEventId: event.id, eventType: event.type }, 'Duplicate Stripe event ignored');
    return { handled: true, duplicate: true };
  }

  if (!company) {
    logger.warn(
      { stripeEventId: event.id, eventType: event.type },
      'Stripe event recorded but no matching company found'
    );
  }

  return { handled: true, duplicate: false };
}
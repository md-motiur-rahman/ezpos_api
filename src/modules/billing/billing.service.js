import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { sendEmail } from '../../utils/mailer.js';
import * as companyRepository from '../company/company.repository.js';
import * as authRepository from '../auth/auth.repository.js';
import * as billingRepository from './billing.repository.js';
import { paymentFailedWarningEmail } from './billing.emailTemplates.js';

const GRACE_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Starts the grace period on a company's FIRST payment failure and emails a
 * warning. Does nothing if a grace period is already running: Stripe retries a
 * failed invoice several times, and resetting the clock on each retry would push
 * lockout out indefinitely so it never actually happened.
 */
async function startGracePeriodIfNeeded(company) {
  if (company.grace_period_ends_at) {
    logger.info(
      { companyId: company.id },
      'Payment failed again during an active grace period - clock not extended'
    );
    return;
  }

  const gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * DAY_MS);
  await companyRepository.setGracePeriodEndsAt(company.id, gracePeriodEndsAt);

  // Non-fatal, same as every other email in this project: the grace period is
  // already recorded, so a failed send doesn't change what happens next.
  try {
    const owner = await authRepository.findUserById(company.owner_user_id);
    if (owner) {
      await sendEmail({
        to: owner.email,
        ...paymentFailedWarningEmail({
          companyName: company.name,
          gracePeriodEndsAt,
          billingUrl: `${config.env.frontendUrl}/billing`,
        }),
      });
    }
  } catch (err) {
    logger.error({ err, companyId: company.id }, 'Failed to send payment failure warning email');
  }
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
      // Payment recovered - end any grace period immediately.
      if (company?.grace_period_ends_at) {
        await companyRepository.setGracePeriodEndsAt(company.id, null);
      }
      break;

    case 'invoice.payment_failed':
      amount = object.amount_due ?? null;
      status = 'failed';
      if (company) {
        await startGracePeriodIfNeeded(company);
      }
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
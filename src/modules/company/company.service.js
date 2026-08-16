import { AppError } from '../../utils/AppError.js';
import { createStripeCustomer, listInvoices } from '../../utils/stripe.js';
import * as companyRepository from './company.repository.js';
import * as shopService from '../shop/shop.service.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function toResponse(company) {
  return {
    id: company.id,
    name: company.name,
    addressLine1: company.address_line1,
    addressLine2: company.address_line2,
    city: company.city,
    postcode: company.postcode,
    country: company.country,
    phone: company.phone,
    vatNumber: company.vat_number,
    companyNumber: company.company_number,
    businessType: company.business_type,
    // 'platform' (default - card payments route through our provider) or
    // 'own' (the shop uses its own bank card terminal, so the till records
    // a card transaction but never calls a provider). Never null - the
    // column is NOT NULL DEFAULT 'platform'.
    cardPaymentMode: company.card_payment_mode,
    // User-facing (unlike stripe_customer_id / stripe_subscription_id, which
    // stay internal) - the dashboard needs it to show "X days left in trial".
    trialEndsAt: company.trial_ends_at,
    // Kept in sync from Stripe webhooks (3.5). Null until the first
    // subscription event arrives.
    subscriptionStatus: company.subscription_status,
    // Non-null means a payment has failed and this is the deadline to fix it
    // before shop access is blocked (3.6). The dashboard uses this to prompt.
    gracePeriodEndsAt: company.grace_period_ends_at,
    createdAt: company.created_at,
    updatedAt: company.updated_at,
  };
}

export async function createCompany(ownerUserId, data) {
  let company;
  try {
    company = await companyRepository.createCompany(ownerUserId, data);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('You already have an active company', 409);
    }
    throw err;
  }
  return toResponse(company);
}

/**
 * Exported so menu.service.js (6.1) reuses this exact "find my active
 * company or 404" logic rather than re-deriving it.
 */
export async function getActiveCompanyOrThrow(ownerUserId) {
  const company = await companyRepository.findActiveCompanyByOwner(ownerUserId);
  if (!company) {
    throw new AppError('No company found for this account', 404);
  }
  return company;
}

export async function getMyCompany(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  return toResponse(company);
}

export async function updateMyCompany(ownerUserId, data) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const updated = await companyRepository.updateCompany(company.id, data);
  return toResponse(updated);
}

export async function deleteMyCompany(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  await companyRepository.softDeleteCompany(company.id);
}

export async function setBusinessType(ownerUserId, ownerEmail, { businessType }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);

  if (businessType === 'single') {
    const shopCount = await shopService.countActiveShops(company.id);
    if (shopCount > 1) {
      throw new AppError(
        'Cannot switch to single-shop while more than one active shop exists. Close shops down to one first.',
        409
      );
    }
  }

  // Create the Stripe customer the first time a business commits to a
  // business_type - idempotent, only happens once per company. This is
  // billing-neutral (no subscription yet, no cost) - Module 3.2 creates
  // the actual Subscription once a shop's line item exists.
  if (!company.stripe_customer_id) {
    const stripeCustomerId = await createStripeCustomer({
      email: ownerEmail,
      name: company.name,
      companyId: company.id,
    });
    await companyRepository.setStripeCustomerId(company.id, stripeCustomerId);
  }

  const updated = await companyRepository.setBusinessType(company.id, businessType);
  return toResponse(updated);
}

/**
 * Chooses whether this company's card payments go through our payment
 * provider ('platform') or are taken on the shop's own bank card terminal
 * ('own'). Its own dedicated action rather than part of the generic
 * PATCH /mine, exactly like setBusinessType above - this changes how money
 * is actually taken, so it shouldn't be settable as an incidental field
 * alongside a phone number.
 *
 * Deliberately NOT one-directional and NOT billing-gated: a shop can switch
 * card terminals, and neither direction invalidates anything already
 * recorded. Payments taken before a switch keep working correctly on refund
 * because refunds key off the payment's own provider_reference, not this
 * setting (see refundPayment in orders/order.service.js).
 */
export async function setCardPaymentMode(ownerUserId, { cardPaymentMode }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const updated = await companyRepository.setCardPaymentMode(company.id, cardPaymentMode);
  return toResponse(updated);
}

export async function getBillingHistory(ownerUserId, { limit }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);

  // No business_type set yet means no Stripe customer exists (3.1) - nothing
  // to fetch. Same "empty array, not an error" convention as listMyShops for
  // a shop-less company. Avoids ever calling Stripe for a company that can't
  // possibly have invoices yet.
  if (!company.stripe_customer_id) {
    return { invoices: [], hasMore: false };
  }

  return listInvoices({ customerId: company.stripe_customer_id, limit });
}
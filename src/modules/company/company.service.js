import { AppError } from '../../utils/AppError.js';
import { createStripeCustomer } from '../../utils/stripe.js';
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

async function getActiveCompanyOrThrow(ownerUserId) {
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
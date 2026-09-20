import { AppError } from '../../utils/AppError.js';
import {
  createStripeCustomer,
  listInvoices,
  createSetupCheckoutSession,
} from '../../utils/stripe.js';
import { roundMoney } from '../../utils/money.js';
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
    // Whether a card is on file. The dashboard gates the first-shop form on
    // this, since createShop now refuses to start a subscription without one.
    hasPaymentMethod: company.has_payment_method,
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

/**
 * Starts hosted Stripe Checkout for collecting a card. The frontend just
 * redirects the browser to the returned url; the card is recorded against the
 * company by the checkout.session.completed webhook, not by anything here -
 * the owner may abandon the page, and only Stripe can tell us they didn't.
 *
 * Requires a Stripe customer, which setBusinessType creates. That ordering is
 * already enforced for shops ("choose single-shop or chain-business before
 * adding a shop"), so this reuses the same prerequisite rather than creating a
 * customer down a second path.
 */
export async function createBillingCheckoutSession(ownerUserId) {
  const company = await getActiveCompanyOrThrow(ownerUserId);

  if (!company.stripe_customer_id) {
    throw new AppError('Choose single-shop or chain-business before adding a payment method', 400);
  }

  const session = await createSetupCheckoutSession({ customerId: company.stripe_customer_id });
  return { url: session.url };
}

/**
 * Dashboard home (Module 15.1). `companyRepository.getDashboardSummary`'s
 * own doc covers what "revenue"/"expense" mean here and why they're each
 * aggregated in isolated CTEs. `totals` is summed here in JS from the
 * already-correct per-day `series` rows rather than a separate SQL SUM
 * query — each row is an exact `numeric` value (pg returns it as a string;
 * `Number()` below is the same parse-not-recompute convention
 * `purchaseOrder.service.js` already uses for `totalCost`), so summing them
 * is exact, not a re-derivation from raw truth the way client-side money
 * math is (§2's rule targets the frontend recombining raw fields it
 * shouldn't trust; this is the backend finishing its own aggregate).
 *
 * **The JS `+=` accumulation itself is NOT exact, though each addend is** -
 * confirmed directly (CodeRabbit) and verified empirically: `Number('10.10')
 * + Number('20.20')` is `30.299999999999997` in IEEE-754, not `30.3`, purely
 * from summing two clean 2dp values - not a corner case, the ordinary
 * result of adding decimal fractions in binary floating point. Individual
 * `series`/`shopBreakdown` rows never go through this (each is a single
 * `Number()` parse of one exact SQL numeric, no JS arithmetic combining
 * them), so they're left alone; only the JS-summed `totals` figures
 * (`revenue`, `expense`, and the `net` subtraction) are run through
 * `roundMoney` before being returned - the same "settle to 2dp, kill the
 * noise before it reaches a response" discipline `order.service.js`
 * already applies to every payment/refund/VAT figure it returns.
 *
 * **`shopCount` is `shopBreakdown.length`, not a separate count query** —
 * the breakdown already lists every active shop for this company (it's a
 * LEFT JOIN FROM shops, so a shop with zero activity in range still gets a
 * row with `revenue: 0`), so counting it again would just be a second query
 * for the same fact.
 */
export async function getDashboardSummary(ownerUserId, { days }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  const { series, shopBreakdown } = await companyRepository.getDashboardSummary(company.id, days);

  const parsedSeries = series.map((row) => ({
    date: row.day,
    revenue: Number(row.revenue),
    expense: Number(row.expense),
    orderCount: row.order_count,
  }));

  const totals = parsedSeries.reduce(
    (acc, row) => {
      acc.revenue += row.revenue;
      acc.expense += row.expense;
      acc.orderCount += row.orderCount;
      return acc;
    },
    { revenue: 0, expense: 0, orderCount: 0 }
  );
  totals.revenue = roundMoney(totals.revenue);
  totals.expense = roundMoney(totals.expense);
  totals.net = roundMoney(totals.revenue - totals.expense);

  const parsedShopBreakdown = shopBreakdown
    .map((row) => ({
      shopId: row.shop_id,
      shopName: row.shop_name,
      revenue: Number(row.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    days,
    shopCount: parsedShopBreakdown.length,
    series: parsedSeries,
    shopBreakdown: parsedShopBreakdown,
    totals,
  };
}
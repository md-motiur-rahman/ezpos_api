import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import {
  createSubscriptionWithShop,
  addSubscriptionItem,
  removeSubscriptionItem,
  cancelSubscriptionAtPeriodEnd,
} from '../../utils/stripe.js';
import config from '../../config/index.js';
import * as companyRepository from '../company/company.repository.js';
import * as shopRepository from './shop.repository.js';
import * as shopAddonRepository from './shopAddon.repository.js';

function toResponse(shop) {
  return {
    id: shop.id,
    name: shop.name,
    addressLine1: shop.address_line1,
    addressLine2: shop.address_line2,
    city: shop.city,
    postcode: shop.postcode,
    country: shop.country,
    phone: shop.phone,
    kdsEnabled: shop.kds_enabled,
    rotaEnabled: shop.rota_enabled,
    vatRegistered: shop.vat_registered,
    // pg returns NUMERIC columns as strings (to avoid float precision loss) -
    // convert to a real number for the API response.
    defaultVatRate: shop.default_vat_rate === null ? null : Number(shop.default_vat_rate),
    createdAt: shop.created_at,
    updatedAt: shop.updated_at,
  };
}

async function getMyActiveCompanyOrThrow(ownerUserId) {
  const company = await companyRepository.findActiveCompanyByOwner(ownerUserId);
  if (!company) {
    throw new AppError('No company found for this account', 404);
  }
  return company;
}

export async function createShop(ownerUserId, data) {
  const company = await getMyActiveCompanyOrThrow(ownerUserId);

  if (!company.business_type) {
    throw new AppError('Choose single-shop or chain-business before adding a shop', 400);
  }

  if (company.business_type === 'single') {
    const count = await shopRepository.countActiveShopsForCompany(company.id);
    if (count >= 1) {
      throw new AppError('A single-shop business can only have one shop', 409);
    }
  }

  const shop = await shopRepository.createShop(company.id, data);

  // Billing: first shop creates the company's subscription (Stripe can't
  // create one with zero items); later shops are added as line items to it.
  // If Stripe fails we roll the shop back, so a shop never exists unbilled.
  try {
    if (company.stripe_subscription_id) {
      const itemId = await addSubscriptionItem({
        subscriptionId: company.stripe_subscription_id,
        priceId: config.env.stripeShopPriceId,
        metadata: { shopId: shop.id },
      });
      await shopRepository.setStripeSubscriptionItemId(shop.id, itemId);
    } else {
      const { subscriptionId, subscriptionItemId } = await createSubscriptionWithShop({
        customerId: company.stripe_customer_id,
        shopId: shop.id,
      });
      await companyRepository.setStripeSubscriptionId(company.id, subscriptionId);
      await shopRepository.setStripeSubscriptionItemId(shop.id, subscriptionItemId);
    }
  } catch (err) {
    await shopRepository.softDeleteShop(shop.id);
    logger.error({ err, shopId: shop.id }, 'Rolled back shop creation after billing failure');
    throw err;
  }

  const created = await shopRepository.findActiveShopByIdForCompany(shop.id, company.id);
  return toResponse(created);
}

export async function listMyShops(ownerUserId) {
  const company = await getMyActiveCompanyOrThrow(ownerUserId);
  const shops = await shopRepository.listActiveShopsForCompany(company.id);
  return shops.map(toResponse);
}

/** Exported so shopAddon.service.js can reuse the same ownership resolution. */
export async function getMyShopOrThrow(ownerUserId, shopId) {
  const company = await getMyActiveCompanyOrThrow(ownerUserId);
  const shop = await shopRepository.findActiveShopByIdForCompany(shopId, company.id);
  if (!shop) {
    throw new AppError('Shop not found', 404);
  }
  return shop;
}

export async function getMyShop(ownerUserId, shopId) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  return toResponse(shop);
}

export async function updateMyShop(ownerUserId, shopId, data) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const updated = await shopRepository.updateShop(shop.id, data);
  return toResponse(updated);
}

export async function deleteMyShop(ownerUserId, shopId) {
  const company = await getMyActiveCompanyOrThrow(ownerUserId);
  const shop = await shopRepository.findActiveShopByIdForCompany(shopId, company.id);
  if (!shop) {
    throw new AppError('Shop not found', 404);
  }

  // Billing is updated BEFORE the shop row is soft-deleted (opposite order
  // to creation, deliberately): we want certainty that billing actually
  // stopped before marking the shop closed, rather than risking a closed
  // shop that's still being charged for.
  const activeCount = await shopRepository.countActiveShopsForCompany(company.id);

  if (activeCount <= 1 && company.stripe_subscription_id) {
    // Last shop. Deleting the final item on a subscription is ambiguous in
    // Stripe, so cancel the whole subscription at period end instead - the
    // company keeps access for the cycle they've already paid for. Any
    // add-on line items are cancelled along with the subscription.
    await cancelSubscriptionAtPeriodEnd({ subscriptionId: company.stripe_subscription_id });
    // Cleared so that adding a shop later starts a fresh subscription
    // rather than trying to reuse a cancelled one.
    await companyRepository.setStripeSubscriptionId(company.id, null);
  } else {
    // Not the last shop, so the subscription lives on - this shop's add-on
    // items must be removed individually, or the company would keep paying
    // for add-ons on a closed shop.
    const addons = await shopAddonRepository.listActiveAddonsForShop(shop.id);
    for (const addon of addons) {
      if (addon.stripe_subscription_item_id) {
        await removeSubscriptionItem({ subscriptionItemId: addon.stripe_subscription_item_id });
      }
    }
    if (shop.stripe_subscription_item_id) {
      await removeSubscriptionItem({ subscriptionItemId: shop.stripe_subscription_item_id });
    }
  }

  await shopAddonRepository.softDeleteAllAddonsForShop(shop.id);
  await shopRepository.softDeleteShop(shop.id);
}

/**
 * Used by company.service.js's setBusinessType - resolves the 2.2 flag:
 * switching to 'single' is blocked if the company has more than one active shop.
 */
export async function countActiveShops(companyId) {
  return shopRepository.countActiveShopsForCompany(companyId);
}
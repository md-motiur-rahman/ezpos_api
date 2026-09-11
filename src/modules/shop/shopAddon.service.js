import config from '../../config/index.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import {
  addSubscriptionItem,
  removeSubscriptionItem,
  setSubscriptionItemQuantity,
} from '../../utils/stripe.js';
import * as companyRepository from '../company/company.repository.js';
import { getMyShopOrThrow } from './shop.service.js';
import * as shopAddonRepository from './shopAddon.repository.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';

function toResponse(addon) {
  return {
    id: addon.id,
    shopId: addon.shop_id,
    addonType: addon.addon_type,
    createdAt: addon.created_at,
    updatedAt: addon.updated_at,
  };
}

export async function activateAddon(ownerUserId, shopId, { addonType }) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const company = await companyRepository.findActiveCompanyByOwner(ownerUserId);

  // A shop can't exist without a subscription (3.2 guarantees this), so this
  // is a safety net rather than an expected path.
  if (!company.stripe_subscription_id) {
    throw new AppError('No active subscription found for this company', 409);
  }

  let addon;
  try {
    addon = await shopAddonRepository.createAddon(shop.id, addonType);
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('That add-on is already active on this shop', 409);
    }
    throw err;
  }

  // Same ordering rationale as shop creation: DB row first, then Stripe,
  // rolling the row back if Stripe fails - an add-on must never appear
  // active while not actually being billed.
  //
  // And the same quantity model: one line item per (company, addonType),
  // shared across every shop that has it active. Creating a second item for
  // the same add-on Price would be rejected by Stripe exactly as a second
  // shop item was, so the second shop to enable an add-on raises quantity.
  try {
    const sharedItemId = await shopAddonRepository.findSharedStripeItemIdForCompanyAddon(
      company.id,
      addonType
    );

    if (sharedItemId) {
      // Absolute count, recomputed from the database - the addon row above is
      // already committed, so this includes it.
      const activeCount = await shopAddonRepository.countActiveAddonsOfTypeForCompany(
        company.id,
        addonType
      );
      await setSubscriptionItemQuantity({
        subscriptionItemId: sharedItemId,
        quantity: activeCount,
      });
      await shopAddonRepository.setStripeSubscriptionItemId(addon.id, sharedItemId);
    } else {
      const itemId = await addSubscriptionItem({
        subscriptionId: company.stripe_subscription_id,
        priceId: config.env.stripeAddonPriceIds[addonType],
        metadata: { shopId: shop.id, addonType },
      });
      await shopAddonRepository.setStripeSubscriptionItemId(addon.id, itemId);
    }
  } catch (err) {
    await shopAddonRepository.softDeleteAddon(addon.id);
    logger.error({ err, addonId: addon.id }, 'Rolled back add-on activation after billing failure');
    throw err;
  }

  return toResponse(addon);
}

export async function listAddons(ownerUserId, shopId) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const addons = await shopAddonRepository.listActiveAddonsForShop(shop.id);
  return addons.map(toResponse);
}

export async function deactivateAddon(ownerUserId, shopId, addonType) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const addon = await shopAddonRepository.findActiveAddon(shop.id, addonType);

  if (!addon) {
    throw new AppError('That add-on is not active on this shop', 404);
  }

  // Stripe first, then the DB - never mark an add-on deactivated while it
  // could still be charged (same rationale as shop deletion).
  //
  // The line item is shared with any other shop in the company running this
  // add-on, so it is only deleted when this was the last one; otherwise the
  // quantity drops and the other shops keep being billed. Counted before the
  // soft-delete below, so this row is still included.
  if (addon.stripe_subscription_item_id) {
    const remaining =
      (await shopAddonRepository.countActiveAddonsOfTypeForCompany(shop.company_id, addonType)) - 1;

    if (remaining > 0) {
      await setSubscriptionItemQuantity({
        subscriptionItemId: addon.stripe_subscription_item_id,
        quantity: remaining,
      });
    } else {
      await removeSubscriptionItem({ subscriptionItemId: addon.stripe_subscription_item_id });
    }
  }
  await shopAddonRepository.softDeleteAddon(addon.id);
}
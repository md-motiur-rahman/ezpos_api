import { AppError } from '../../utils/AppError.js';
import { resolveActorAuthority } from '../staff/actorAuthority.js';
import * as shopRepository from '../shop/shop.repository.js';

/**
 * The few shop details printed at the top of a receipt: name, address, phone.
 * The regular shop read is owner-only, so a till signed in as staff had no way
 * to get them. Open to any actor in scope of the shop (an owner of it, or
 * staff working in it, with no separate permission), the same as the menu -
 * a cashier handing over a receipt can already see the shop's name.
 * resolveActorAuthority does the scoping and 404s any other shop.
 */
export async function getReceiptInfo(actor, shopId) {
  await resolveActorAuthority(actor, shopId);
  const shop = await shopRepository.findActiveShopById(shopId);
  if (!shop) {
    throw new AppError('Shop not found', 404);
  }
  return {
    name: shop.name,
    addressLine1: shop.address_line1,
    addressLine2: shop.address_line2,
    city: shop.city,
    postcode: shop.postcode,
    phone: shop.phone,
  };
}

import { AppError } from '../../utils/AppError.js';
import * as companyRepository from '../company/company.repository.js';
import * as shopRepository from './shop.repository.js';

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
  return toResponse(shop);
}

export async function listMyShops(ownerUserId) {
  const company = await getMyActiveCompanyOrThrow(ownerUserId);
  const shops = await shopRepository.listActiveShopsForCompany(company.id);
  return shops.map(toResponse);
}

async function getMyShopOrThrow(ownerUserId, shopId) {
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
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  await shopRepository.softDeleteShop(shop.id);
  // NOTE (Module 3 dependency): closing a shop should also remove/adjust
  // its per-shop subscription line item on the billing side. No billing
  // module exists yet to hook into - revisit this when Module 3 is built.
}

/**
 * Used by company.service.js's setBusinessType - resolves the 2.2 flag:
 * switching to 'single' is blocked if the company has more than one active shop.
 */
export async function countActiveShops(companyId) {
  return shopRepository.countActiveShopsForCompany(companyId);
}
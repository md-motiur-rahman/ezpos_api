import { AppError } from '../../utils/AppError.js';
import * as companyRepository from './company.repository.js';

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

export async function setBusinessType(ownerUserId, { businessType }) {
  const company = await getActiveCompanyOrThrow(ownerUserId);
  // NOTE: no restriction on switching chain -> single yet, even if the
  // company already has multiple shops - that check needs the shops table,
  // which doesn't exist until Module 2.3. Guard to be added there.
  const updated = await companyRepository.setBusinessType(company.id, businessType);
  return toResponse(updated);
}
import { AppError } from '../../utils/AppError.js';
import { requireViewInventory, requireManageInventory } from '../inventory/inventory.service.js';
import * as supplierRepository from './supplier.repository.js';

function toResponse(supplier) {
  return {
    id: supplier.id,
    shopId: supplier.shop_id,
    name: supplier.name,
    contactName: supplier.contact_name,
    phone: supplier.phone,
    email: supplier.email,
    notes: supplier.notes,
    createdAt: supplier.created_at,
    updatedAt: supplier.updated_at,
  };
}

export async function createSupplier(actor, shopId, data) {
  await requireManageInventory(actor, shopId);
  const supplier = await supplierRepository.createSupplier(shopId, data);
  return toResponse(supplier);
}

export async function listSuppliers(actor, shopId) {
  await requireViewInventory(actor, shopId);
  const suppliers = await supplierRepository.listActiveSuppliersForShop(shopId);
  return suppliers.map(toResponse);
}

async function getSupplierOrThrow(shopId, supplierId) {
  const supplier = await supplierRepository.findActiveSupplierByIdForShop(supplierId, shopId);
  if (!supplier) {
    throw new AppError('Supplier not found', 404);
  }
  return supplier;
}

export async function getSupplier(actor, shopId, supplierId) {
  await requireViewInventory(actor, shopId);
  const supplier = await getSupplierOrThrow(shopId, supplierId);
  return toResponse(supplier);
}

export async function updateSupplier(actor, shopId, supplierId, data) {
  await requireManageInventory(actor, shopId);
  await getSupplierOrThrow(shopId, supplierId);

  const updated = await supplierRepository.updateSupplier(supplierId, data);
  return toResponse(updated);
}

export async function deleteSupplier(actor, shopId, supplierId) {
  await requireManageInventory(actor, shopId);
  const supplier = await getSupplierOrThrow(shopId, supplierId);
  await supplierRepository.softDeleteSupplier(supplier.id);
}
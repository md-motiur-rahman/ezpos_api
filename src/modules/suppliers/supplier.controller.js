import { asyncHandler } from '../../utils/asyncHandler.js';
import * as supplierService from './supplier.service.js';

export const createSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.createSupplier(req.actor, req.params.shopId, req.body);
  res.status(201).json(supplier);
});

export const listSuppliers = asyncHandler(async (req, res) => {
  const suppliers = await supplierService.listSuppliers(req.actor, req.params.shopId);
  res.status(200).json(suppliers);
});

export const getSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.getSupplier(req.actor, req.params.shopId, req.params.supplierId);
  res.status(200).json(supplier);
});

export const updateSupplier = asyncHandler(async (req, res) => {
  const supplier = await supplierService.updateSupplier(
    req.actor,
    req.params.shopId,
    req.params.supplierId,
    req.body
  );
  res.status(200).json(supplier);
});

export const deleteSupplier = asyncHandler(async (req, res) => {
  await supplierService.deleteSupplier(req.actor, req.params.shopId, req.params.supplierId);
  res.status(200).json({ message: 'Supplier deleted.' });
});
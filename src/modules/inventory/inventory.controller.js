import { asyncHandler } from '../../utils/asyncHandler.js';
import * as inventoryService from './inventory.service.js';

export const createItem = asyncHandler(async (req, res) => {
  const item = await inventoryService.createItem(req.actor, req.params.shopId, req.body);
  res.status(201).json(item);
});

export const listItems = asyncHandler(async (req, res) => {
  const items = await inventoryService.listItems(req.actor, req.params.shopId, req.query);
  res.status(200).json(items);
});

export const getItem = asyncHandler(async (req, res) => {
  const item = await inventoryService.getItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json(item);
});

export const updateItem = asyncHandler(async (req, res) => {
  const item = await inventoryService.updateItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.body
  );
  res.status(200).json(item);
});

export const deleteItem = asyncHandler(async (req, res) => {
  await inventoryService.deleteItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json({ message: 'Inventory item deleted.' });
});

// --- Item <-> supplier linking (7.4) ---

export const attachSupplierToItem = asyncHandler(async (req, res) => {
  await inventoryService.attachSupplierToItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.supplierId,
    req.body.isDefault
  );
  res.status(201).json({ message: 'Supplier linked.' });
});

export const updateItemSupplierDefault = asyncHandler(async (req, res) => {
  await inventoryService.updateItemSupplierDefault(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.supplierId,
    req.body.isDefault
  );
  res.status(200).json({ message: 'Supplier link updated.' });
});

export const detachSupplierFromItem = asyncHandler(async (req, res) => {
  await inventoryService.detachSupplierFromItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.params.supplierId
  );
  res.status(200).json({ message: 'Supplier unlinked.' });
});

export const listItemSuppliers = asyncHandler(async (req, res) => {
  const suppliers = await inventoryService.listItemSuppliers(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json(suppliers);
});

// --- Cross-shop overview (7.8) ---

export const listItemsForCompany = asyncHandler(async (req, res) => {
  const items = await inventoryService.listItemsForCompany(req.user.id, req.query);
  res.status(200).json(items);
});
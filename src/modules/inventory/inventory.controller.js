import { asyncHandler } from '../../utils/asyncHandler.js';
import * as inventoryService from './inventory.service.js';

export const createItem = asyncHandler(async (req, res) => {
  const item = await inventoryService.createItem(req.actor, req.params.shopId, req.body);
  res.status(201).json(item);
});

export const listItems = asyncHandler(async (req, res) => {
  const items = await inventoryService.listItems(req.actor, req.params.shopId);
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
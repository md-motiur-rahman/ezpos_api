import { asyncHandler } from '../../utils/asyncHandler.js';
import * as shopMenuService from './shopMenu.service.js';

export const getResolvedMenu = asyncHandler(async (req, res) => {
  const menu = await shopMenuService.getResolvedMenu(req.actor, req.params.shopId);
  res.status(200).json(menu);
});

export const setOverride = asyncHandler(async (req, res) => {
  const override = await shopMenuService.setOverride(
    req.actor,
    req.params.shopId,
    req.params.menuItemId,
    req.body
  );
  res.status(200).json(override);
});

export const clearOverride = asyncHandler(async (req, res) => {
  await shopMenuService.clearOverride(req.actor, req.params.shopId, req.params.menuItemId);
  res.status(200).json({ message: 'Override cleared - reverted to master defaults.' });
});

export const createLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.createLocalItem(req.actor, req.params.shopId, req.body);
  res.status(201).json(item);
});

export const listLocalItems = asyncHandler(async (req, res) => {
  const items = await shopMenuService.listLocalItems(req.actor, req.params.shopId);
  res.status(200).json(items);
});

export const getLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.getLocalItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json(item);
});

export const updateLocalItem = asyncHandler(async (req, res) => {
  const item = await shopMenuService.updateLocalItem(
    req.actor,
    req.params.shopId,
    req.params.itemId,
    req.body
  );
  res.status(200).json(item);
});

export const deleteLocalItem = asyncHandler(async (req, res) => {
  await shopMenuService.deleteLocalItem(req.actor, req.params.shopId, req.params.itemId);
  res.status(200).json({ message: 'Local menu item deleted.' });
});
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as shopService from './shop.service.js';

export const createShop = asyncHandler(async (req, res) => {
  const shop = await shopService.createShop(req.user.id, req.body);
  res.status(201).json(shop);
});

export const listMyShops = asyncHandler(async (req, res) => {
  const shops = await shopService.listMyShops(req.user.id);
  res.status(200).json(shops);
});

export const getMyShop = asyncHandler(async (req, res) => {
  const shop = await shopService.getMyShop(req.user.id, req.params.id);
  res.status(200).json(shop);
});

export const updateMyShop = asyncHandler(async (req, res) => {
  const shop = await shopService.updateMyShop(req.user.id, req.params.id, req.body);
  res.status(200).json(shop);
});

export const deleteMyShop = asyncHandler(async (req, res) => {
  await shopService.deleteMyShop(req.user.id, req.params.id);
  res.status(200).json({ message: 'Shop closed.' });
});
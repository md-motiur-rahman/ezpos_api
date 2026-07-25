import { asyncHandler } from '../../utils/asyncHandler.js';
import * as shopAddonService from './shopAddon.service.js';

export const activateAddon = asyncHandler(async (req, res) => {
  const addon = await shopAddonService.activateAddon(req.user.id, req.params.shopId, req.body);
  res.status(201).json(addon);
});

export const listAddons = asyncHandler(async (req, res) => {
  const addons = await shopAddonService.listAddons(req.user.id, req.params.shopId);
  res.status(200).json(addons);
});

export const deactivateAddon = asyncHandler(async (req, res) => {
  await shopAddonService.deactivateAddon(req.user.id, req.params.shopId, req.params.addonType);
  res.status(200).json({ message: 'Add-on deactivated.' });
});
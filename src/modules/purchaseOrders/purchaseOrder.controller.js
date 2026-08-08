import { asyncHandler } from '../../utils/asyncHandler.js';
import * as purchaseOrderService from './purchaseOrder.service.js';

export const createPurchaseOrder = asyncHandler(async (req, res) => {
  const po = await purchaseOrderService.createPurchaseOrder(req.actor, req.params.shopId, req.body);
  res.status(201).json(po);
});

export const listPurchaseOrders = asyncHandler(async (req, res) => {
  const purchaseOrders = await purchaseOrderService.listPurchaseOrders(req.actor, req.params.shopId);
  res.status(200).json(purchaseOrders);
});

export const getPurchaseOrder = asyncHandler(async (req, res) => {
  const po = await purchaseOrderService.getPurchaseOrder(req.actor, req.params.shopId, req.params.poId);
  res.status(200).json(po);
});

export const deletePurchaseOrder = asyncHandler(async (req, res) => {
  await purchaseOrderService.deletePurchaseOrder(req.actor, req.params.shopId, req.params.poId);
  res.status(200).json({ message: 'Purchase order deleted.' });
});
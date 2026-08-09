import { asyncHandler } from '../../utils/asyncHandler.js';
import * as orderService from './order.service.js';

export const createOrder = asyncHandler(async (req, res) => {
  const order = await orderService.createOrder(req.actor, req.params.shopId, req.body);
  res.status(201).json(order);
});

export const listOrders = asyncHandler(async (req, res) => {
  const orders = await orderService.listOrders(req.actor, req.params.shopId);
  res.status(200).json(orders);
});

export const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.actor, req.params.shopId, req.params.orderId);
  res.status(200).json(order);
});

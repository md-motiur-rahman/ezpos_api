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

export const addItemsToOrder = asyncHandler(async (req, res) => {
  const order = await orderService.addItemsToOrder(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.body
  );
  res.status(201).json(order);
});

export const setOrderDiscount = asyncHandler(async (req, res) => {
  const order = await orderService.setOrderDiscount(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.body
  );
  res.status(200).json(order);
});

export const setOrderItemDiscount = asyncHandler(async (req, res) => {
  const order = await orderService.setOrderItemDiscount(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.params.orderItemId,
    req.body
  );
  res.status(200).json(order);
});

export const cancelOrder = asyncHandler(async (req, res) => {
  const order = await orderService.cancelOrder(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.body
  );
  res.status(200).json(order);
});

export const voidOrderItem = asyncHandler(async (req, res) => {
  const order = await orderService.voidOrderItem(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.params.orderItemId,
    req.body
  );
  res.status(200).json(order);
});

export const recordPayment = asyncHandler(async (req, res) => {
  const order = await orderService.recordPayment(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.body
  );
  res.status(201).json(order);
});

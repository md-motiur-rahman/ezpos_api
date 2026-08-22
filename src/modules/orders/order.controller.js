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

// 201 - a refund CREATES a new immutable order_refunds row, same as
// recordPayment creating a payment row, rather than mutating anything.
export const refundPayment = asyncHandler(async (req, res) => {
  const order = await orderService.refundPayment(
    req.actor,
    req.params.shopId,
    req.params.orderId,
    req.params.paymentId,
    req.body
  );
  res.status(201).json(order);
});

/**
 * Offline sync (9.7) - the ONE handler here whose status code is not fixed,
 * because the two outcomes are genuinely different events and the till needs
 * to tell them apart:
 *   201 - this queued sale was accepted and an order was created.
 *   200 - it had already been synced; this was an idempotent replay and
 *         nothing new was written.
 * Both return the identical order body, so a client that ignores the
 * distinction still behaves correctly - it just learns less. Hence the
 * service returning { order, created } rather than the order alone.
 */
export const syncOfflineOrder = asyncHandler(async (req, res) => {
  const { order, created } = await orderService.syncOfflineOrder(
    req.actor,
    req.params.shopId,
    req.body
  );
  res.status(created ? 201 : 200).json(order);
});

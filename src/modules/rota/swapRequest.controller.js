import { asyncHandler } from '../../utils/asyncHandler.js';
import * as swapRequestService from './swapRequest.service.js';

export const createSwapRequest = asyncHandler(async (req, res) => {
  const request = await swapRequestService.createSwapRequest(req.actor, req.params.shopId, req.body);
  res.status(201).json(request);
});

export const listSwapRequests = asyncHandler(async (req, res) => {
  const requests = await swapRequestService.listSwapRequests(req.actor, req.params.shopId, req.query);
  res.status(200).json(requests);
});

export const getSwapRequest = asyncHandler(async (req, res) => {
  const request = await swapRequestService.getSwapRequest(
    req.actor,
    req.params.shopId,
    req.params.requestId
  );
  res.status(200).json(request);
});

export const approveSwapRequest = asyncHandler(async (req, res) => {
  const request = await swapRequestService.approveSwapRequest(
    req.actor,
    req.params.shopId,
    req.params.requestId
  );
  res.status(200).json(request);
});

export const rejectSwapRequest = asyncHandler(async (req, res) => {
  const request = await swapRequestService.rejectSwapRequest(
    req.actor,
    req.params.shopId,
    req.params.requestId
  );
  res.status(200).json(request);
});
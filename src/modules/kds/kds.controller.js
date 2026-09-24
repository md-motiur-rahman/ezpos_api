import { asyncHandler } from '../../utils/asyncHandler.js';
import { bearerTokenFrom } from '../staffAuth/actorFromToken.js';
import * as kdsTicketService from './kdsTicket.service.js';
import * as orderService from '../orders/order.service.js';

/**
 * `POST /api/shops/:shopId/kds/ticket` - see `kdsTicket.service.js`'s own
 * doc for the full "why" of this endpoint.
 *
 * `bearerTokenFrom(req.headers.authorization)` is guaranteed non-null here,
 * not re-validated: `requireStaffOrOwnerAuth` (mounted ahead of this route
 * in `kds.routes.js`) already parsed this exact header and 401'd if it
 * were missing or invalid before `req.actor` could ever be set.
 */
export const createTicket = asyncHandler(async (req, res) => {
  const token = bearerTokenFrom(req.headers.authorization);
  const result = await kdsTicketService.mintKdsTicket(req.actor, req.params.shopId, token);
  res.status(201).json(result);
});

/**
 * `GET /api/shops/:shopId/kds/orders` (Module 15.2) - the board's initial
 * snapshot. Lives here, not in `order.controller.js`, even though the
 * business logic it calls (`orderService.listKdsOrders`) lives WITH the
 * rest of the order module (same "gate lives with the resource" reasoning
 * `setOrderItemStatus`'s own VIEW_KDS gate already follows) - this route
 * itself is part of the KDS's own REST surface (`/kds/...`, sitting next
 * to `/kds/ticket` and, conceptually, `/kds/socket`), not the till's
 * ACCESS_TILL-gated `/orders` surface a Chef is correctly 403'd from.
 */
export const listOrders = asyncHandler(async (req, res) => {
  const orders = await orderService.listKdsOrders(req.actor, req.params.shopId);
  res.status(200).json(orders);
});

import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateParams, validateQuery } from '../../middleware/validate.js';
import * as kdsController from './kds.controller.js';
import { kdsHistoryQuerySchema } from './kds.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted at /api/shops/:shopId/kds in app.js - a genuinely ordinary
 * Express route, unlike this same shop's `/kds/socket` path, which never
 * reaches Express at all (`kdsSocket.js`'s own top-of-file doc explains
 * why an `Upgrade: websocket` request bypasses the 'request' listener
 * entirely). The two are siblings under the same `/kds` prefix but are
 * handled by completely different machinery - there is no route collision
 * to worry about because Express's router is never even consulted for the
 * other one.
 *
 * mergeParams: true required even for this top-level mount - verified
 * empirically in 4.5, same as every other shop-scoped router in this
 * project.
 *
 * Named `kds.routes.js`, not `kdsTicket.routes.js` (Module 15.1's original
 * name) - Module 15.2 added `/orders`, a second endpoint with nothing
 * ticket-specific about it, so the file's own name widened to match what
 * it actually holds rather than staying a slight misnomer. `kdsTicket.
 * service.js` keeps its own name: the ticket mint/consume LOGIC is still
 * genuinely ticket-only, only the routes/controller layer needed the
 * broader name.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post('/ticket', validateParams(shopIdOnlyParamSchema), kdsController.createTicket);
router.get('/orders', validateParams(shopIdOnlyParamSchema), kdsController.listOrders);
router.get(
  '/history',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(kdsHistoryQuerySchema),
  kdsController.listHistory
);

export default router;

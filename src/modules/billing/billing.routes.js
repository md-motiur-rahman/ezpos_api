import { Router, raw } from 'express';
import * as billingController from './billing.controller.js';

const router = Router();

/**
 * Deliberately NOT behind requireAuth: Stripe isn't a logged-in user of ours.
 * The signature check in the controller is the authentication.
 *
 * express.raw keeps req.body as a Buffer for this route only - the global
 * express.json() would otherwise parse it and break verification.
 */
router.post('/stripe', raw({ type: 'application/json' }), billingController.handleStripeWebhook);

export default router;
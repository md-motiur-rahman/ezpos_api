import { asyncHandler } from '../../utils/asyncHandler.js';
import { constructWebhookEvent } from '../../utils/stripe.js';
import * as billingService from './billing.service.js';

export const handleStripeWebhook = asyncHandler(async (req, res) => {
  // req.body is a raw Buffer here (express.raw on this route only) - required
  // for signature verification to work.
  const event = constructWebhookEvent({
    rawBody: req.body,
    signature: req.headers['stripe-signature'],
  });

  await billingService.handleWebhookEvent(event);

  // Always 200 once the signature is valid and processing succeeded, so Stripe
  // stops retrying. Failures throw and surface as non-2xx, which is what
  // triggers a retry.
  res.status(200).json({ received: true });
});
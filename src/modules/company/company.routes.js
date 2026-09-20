import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validateBody, validateQuery } from '../../middleware/validate.js';
import * as companyController from './company.controller.js';
import {
  createCompanySchema,
  updateCompanySchema,
  businessTypeSchema,
  cardPaymentModeSchema,
  billingHistoryQuerySchema,
  dashboardSummaryQuerySchema,
} from './company.validation.js';
import menuRoutes from '../menu/menu.routes.js';

const router = Router();

router.use(requireAuth);

router.post('/', validateBody(createCompanySchema), companyController.createCompany);
router.get('/mine', companyController.getMyCompany);
router.patch('/mine', validateBody(updateCompanySchema), companyController.updateMyCompany);
router.delete('/mine', companyController.deleteMyCompany);
router.post(
  '/mine/business-type',
  validateBody(businessTypeSchema),
  companyController.setBusinessType
);
// Own dedicated action rather than part of PATCH /mine, same reasoning as
// business-type above: this decides how money is actually taken.
router.post(
  '/mine/card-payment-mode',
  validateBody(cardPaymentModeSchema),
  companyController.setCardPaymentMode
);
// Deliberately NOT behind requireActiveBilling (3.6): this is exactly the
// visibility a locked-out owner needs to see what they owe and pay it.
router.get(
  '/mine/billing-history',
  validateQuery(billingHistoryQuerySchema),
  companyController.getBillingHistory
);
// Same reasoning, and more so: a locked-out company's way OUT is adding a
// working card, so this must stay reachable while locked.
router.post('/mine/billing/checkout-session', companyController.createBillingCheckoutSession);
// Dashboard home (15.1). Deliberately NOT behind requireActiveBilling, same
// "reading stays available" reasoning as billing-history above - a
// locked-out owner can still see how the business has been doing.
router.get(
  '/mine/dashboard-summary',
  validateQuery(dashboardSummaryQuerySchema),
  companyController.getDashboardSummary
);
// Menu management (6.1) - see menu.routes.js for why this is nested here
// rather than an independent top-level mount.
router.use('/mine', menuRoutes);

export default router;
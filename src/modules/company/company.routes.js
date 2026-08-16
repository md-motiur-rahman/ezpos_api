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
// Menu management (6.1) - see menu.routes.js for why this is nested here
// rather than an independent top-level mount.
router.use('/mine', menuRoutes);

export default router;
import { Router } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { validateBody } from '../../middleware/validate.js';
import * as companyController from './company.controller.js';
import { createCompanySchema, updateCompanySchema } from './company.validation.js';

const router = Router();

router.use(requireAuth);

router.post('/', validateBody(createCompanySchema), companyController.createCompany);
router.get('/mine', companyController.getMyCompany);
router.patch('/mine', validateBody(updateCompanySchema), companyController.updateMyCompany);
router.delete('/mine', companyController.deleteMyCompany);

export default router;
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as companyService from './company.service.js';

export const createCompany = asyncHandler(async (req, res) => {
  const company = await companyService.createCompany(req.user.id, req.body);
  res.status(201).json(company);
});

export const getMyCompany = asyncHandler(async (req, res) => {
  const company = await companyService.getMyCompany(req.user.id);
  res.status(200).json(company);
});

export const updateMyCompany = asyncHandler(async (req, res) => {
  const company = await companyService.updateMyCompany(req.user.id, req.body);
  res.status(200).json(company);
});

export const deleteMyCompany = asyncHandler(async (req, res) => {
  await companyService.deleteMyCompany(req.user.id);
  res.status(200).json({ message: 'Company deleted.' });
});

export const setBusinessType = asyncHandler(async (req, res) => {
  const company = await companyService.setBusinessType(req.user.id, req.user.email, req.body);
  res.status(200).json(company);
});

export const getBillingHistory = asyncHandler(async (req, res) => {
  const history = await companyService.getBillingHistory(req.user.id, req.query);
  res.status(200).json(history);
});
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as staffPermissionService from './staffPermission.service.js';

export const grantPermission = asyncHandler(async (req, res) => {
  const override = await staffPermissionService.grantPermission(
    req.actor,
    req.params.staffId,
    req.body.permission
  );
  res.status(201).json(override);
});

export const listEffectivePermissions = asyncHandler(async (req, res) => {
  const result = await staffPermissionService.listEffectivePermissions(req.actor, req.params.staffId);
  res.status(200).json(result);
});

export const revokePermission = asyncHandler(async (req, res) => {
  await staffPermissionService.revokePermission(req.actor, req.params.staffId, req.params.permission);
  res.status(200).json({ message: 'Permission revoked.' });
});

export const listAuditLog = asyncHandler(async (req, res) => {
  const log = await staffPermissionService.listAuditLog(req.actor, req.params.shopId, req.query.limit);
  res.status(200).json(log);
});
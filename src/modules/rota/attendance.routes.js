import { Router } from 'express';
import { requireStaffOrOwnerAuth } from '../../middleware/requireStaffOrOwnerAuth.js';
import { validateParams, validateQuery } from '../../middleware/validate.js';
import * as attendanceController from './attendance.controller.js';
import {
  attendanceListQuerySchema,
  attendanceRecordIdParamSchema,
} from './attendance.validation.js';
import { shopIdOnlyParamSchema } from '../staff/staff.validation.js';

/**
 * Mounted independently at /api/shops/:shopId/attendance in app.js, same
 * pattern as rota.routes.js (5.1) and swapRequest.routes.js (5.2).
 *
 * mergeParams: true required even for this top-level mount - verified
 * empirically in 4.5.
 *
 * /comparison MUST be registered before /:recordId - verified empirically
 * that, unlike 4.6's audit-log path (different segment count, genuinely
 * order-independent), these two are both single-segment patterns and DO
 * collide: with the order reversed, GET /attendance/comparison gets
 * swallowed by /:recordId (recordId = "comparison"), never reaching the
 * comparison handler at all.
 *
 * Deliberately NOT behind requireActiveBillingForShop, unlike rota.routes.js
 * and swapRequest.routes.js's own writes: clocking in/out is a labor-law/
 * wage-record necessity, not a discretionary shop-floor action a billing
 * problem should ever be allowed to interrupt - an employee still
 * physically shows up and works a shift regardless of whether their
 * employer's own EzPOS subscription is current, and this app has no
 * business standing between them and an accurate attendance record.
 */
const router = Router({ mergeParams: true });

router.use(requireStaffOrOwnerAuth);

router.post('/clock-in', validateParams(shopIdOnlyParamSchema), attendanceController.clockIn);
router.post('/clock-out', validateParams(shopIdOnlyParamSchema), attendanceController.clockOut);
router.get(
  '/comparison',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(attendanceListQuerySchema),
  attendanceController.compareAttendanceToRota
);
router.get(
  '/',
  validateParams(shopIdOnlyParamSchema),
  validateQuery(attendanceListQuerySchema),
  attendanceController.listAttendance
);
router.get(
  '/:recordId',
  validateParams(attendanceRecordIdParamSchema),
  attendanceController.getAttendanceRecord
);

export default router;
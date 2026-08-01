import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS, hasEffectivePermission } from '../staff/permissions.js';
import { assertHasPermission } from '../staff/actorAuthority.js';
import { requireRotaEnabledScope } from './rota.service.js';
import * as rotaRepository from './rota.repository.js';
import * as attendanceRepository from './attendance.repository.js';

const VIEW_OTHERS_MESSAGE = "You do not have permission to view other staff members' attendance";

function toResponse(row) {
  return {
    id: row.id,
    staffId: row.staff_id,
    clockedInAt: row.clocked_in_at,
    clockedOutAt: row.clocked_out_at,
    createdAt: row.created_at,
  };
}

/**
 * Clock-in/out is inherently a shop-floor action tied to a staff row. The
 * Owner has no staff row to attach a record to - this isn't a permission
 * choice, it's a consequence of the schema (attendance_records.staff_id
 * references staff, not users).
 */
function requireStaffActor(actor) {
  if (actor.type !== 'staff') {
    throw new AppError('Only staff can clock in or out', 400);
  }
}

export async function clockIn(actor, shopId) {
  await requireRotaEnabledScope(actor, shopId);
  requireStaffActor(actor);

  const existing = await attendanceRepository.findOpenRecordForStaff(actor.id);
  if (existing) {
    throw new AppError('Already clocked in', 409);
  }

  const record = await attendanceRepository.clockIn(actor.id);
  return toResponse(record);
}

export async function clockOut(actor, shopId) {
  await requireRotaEnabledScope(actor, shopId);
  requireStaffActor(actor);

  const existing = await attendanceRepository.findOpenRecordForStaff(actor.id);
  if (!existing) {
    throw new AppError('Not currently clocked in', 409);
  }

  const record = await attendanceRepository.clockOut(existing.id);
  return toResponse(record);
}

/**
 * Self-scoped unless the actor has manage_rota: a Server sees only their own
 * attendance. Requesting someone else's staffId without manage_rota is
 * silently narrowed back to the actor's own records rather than treated as
 * an error - listing is inherently "show me what I'm allowed to see".
 */
export async function listAttendance(actor, shopId, { staffId, from, to }) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  const canViewShopWide = hasEffectivePermission(
    authority.role,
    authority.activeOverridePermissions,
    PERMISSIONS.MANAGE_ROTA
  );

  const effectiveStaffId = canViewShopWide ? (staffId ?? null) : actor.id;
  const rows = await attendanceRepository.listForShopInRange(shopId, from, to, effectiveStaffId);
  return rows.map(toResponse);
}

/**
 * Unlike listing, viewing ONE specific record that isn't the actor's own is
 * treated as an explicit boundary and throws 403 rather than being narrowed
 * silently.
 */
export async function getAttendanceRecord(actor, shopId, recordId) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  const record = await attendanceRepository.findByIdForShop(recordId, shopId);
  if (!record) {
    throw new AppError('Attendance record not found', 404);
  }

  const isOwnRecord = actor.type === 'staff' && actor.id === record.staff_id;
  if (!isOwnRecord) {
    assertHasPermission(authority, PERMISSIONS.MANAGE_ROTA, VIEW_OTHERS_MESSAGE);
  }

  return toResponse(record);
}

/**
 * Reporting view, not self-service - requires manage_rota regardless of
 * whose attendance is being compared.
 *
 * Classification is done in application code rather than a single complex
 * SQL query, deliberately - it's easier to read, test, and adjust:
 *   - no_show:     a rota shift with no overlapping attendance at all
 *   - completed:   has both a clock-in and a clock-out
 *   - in_progress: clocked in, not yet clocked out
 *   - unscheduled: an attendance record with no matching rota shift
 *
 * Deliberately NOT computing "late" or "left early" - that needs a
 * tolerance threshold (5 min? 15?) that's a business policy decision, not
 * specified anywhere. Raw scheduled-vs-actual timestamps are returned so
 * that decision can be made later without this data shape needing to change.
 */
export async function compareAttendanceToRota(actor, shopId, { staffId, from, to }) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.MANAGE_ROTA,
    'You do not have permission to view the attendance comparison'
  );

  const allShifts = await rotaRepository.listShiftsForShopInRange(shopId, from, to);
  const shifts = staffId ? allShifts.filter((shift) => shift.staff_id === staffId) : allShifts;
  const attendance = await attendanceRepository.listForShopInRange(shopId, from, to, staffId ?? null);

  const matchedRecordIds = new Set();

  const shiftEntries = shifts.map((shift) => {
    const matches = attendance.filter((record) => {
      if (record.staff_id !== shift.staff_id) {
        return false;
      }
      const recordEnd = record.clocked_out_at ? new Date(record.clocked_out_at) : new Date();
      return new Date(record.clocked_in_at) < new Date(shift.end_time) && recordEnd > new Date(shift.start_time);
    });
    matches.forEach((match) => matchedRecordIds.add(match.id));

    const primaryMatch = matches[0] ?? null;
    let status;
    if (!primaryMatch) {
      status = 'no_show';
    } else if (primaryMatch.clocked_out_at) {
      status = 'completed';
    } else {
      status = 'in_progress';
    }

    return {
      shiftId: shift.id,
      staffId: shift.staff_id,
      scheduledStart: shift.start_time,
      scheduledEnd: shift.end_time,
      clockedInAt: primaryMatch?.clocked_in_at ?? null,
      clockedOutAt: primaryMatch?.clocked_out_at ?? null,
      status,
    };
  });

  const unscheduledEntries = attendance
    .filter((record) => !matchedRecordIds.has(record.id))
    .map((record) => ({
      shiftId: null,
      staffId: record.staff_id,
      scheduledStart: null,
      scheduledEnd: null,
      clockedInAt: record.clocked_in_at,
      clockedOutAt: record.clocked_out_at,
      status: 'unscheduled',
    }));

  return [...shiftEntries, ...unscheduledEntries];
}
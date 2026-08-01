import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { assertHasPermission } from '../staff/actorAuthority.js';
import { requireRotaEnabledScope, updateShift as updateRotaShift } from './rota.service.js';
import * as rotaRepository from './rota.repository.js';
import * as staffRepository from '../staff/staff.repository.js';
import * as swapRequestRepository from './swapRequest.repository.js';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const MANAGE_ROTA_MESSAGE = 'You do not have permission to manage the rota';

function toResponse(row) {
  return {
    id: row.id,
    shiftId: row.shift_id,
    fromStaffId: row.from_staff_id,
    toStaffId: row.to_staff_id,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    status: row.status,
    decidedByType: row.decided_by_type,
    decidedById: row.decided_by_id,
    decidedAt: row.decided_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/**
 * Create is deliberately more permissive than approve/reject: the shift's
 * OWN staff member can always request a swap for themselves (self-service,
 * no manage_rota needed - a Server should be able to ask to swap out of
 * their own shift). Anyone else acting on someone else's shift (e.g. a
 * manager arranging cover) needs manage_rota, same as every other rota
 * mutation.
 */
export async function createSwapRequest(actor, shopId, { shiftId, toStaffId, notes }) {
  const authority = await requireRotaEnabledScope(actor, shopId);

  const shift = await rotaRepository.findActiveShiftByIdForShop(shiftId, shopId);
  if (!shift) {
    throw new AppError('Shift not found', 404);
  }

  const isOwnShift = actor.type === 'staff' && actor.id === shift.staff_id;
  if (!isOwnShift) {
    assertHasPermission(authority, PERMISSIONS.MANAGE_ROTA, MANAGE_ROTA_MESSAGE);
  }

  if (toStaffId === shift.staff_id) {
    throw new AppError('toStaffId must be different from the shift\'s current staff member', 400);
  }

  const toStaff = await staffRepository.findActiveStaffByIdForShop(toStaffId, shopId);
  if (!toStaff) {
    throw new AppError('Staff member not found', 404);
  }

  let request;
  try {
    request = await swapRequestRepository.create({
      shiftId,
      fromStaffId: shift.staff_id,
      toStaffId,
      requestedByType: actor.type,
      requestedById: actor.id,
      notes,
    });
  } catch (err) {
    if (err.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('A pending swap request already exists for this shift', 409);
    }
    throw err;
  }

  return toResponse(request);
}

export async function listSwapRequests(actor, shopId, { status } = {}) {
  await requireRotaEnabledScope(actor, shopId); // reads stay open, same as 5.1
  const rows = await swapRequestRepository.listForShop(shopId, status);
  return rows.map(toResponse);
}

async function getRequestOrThrow(shopId, requestId) {
  const row = await swapRequestRepository.findByIdForShop(requestId, shopId);
  if (!row) {
    throw new AppError('Swap request not found', 404);
  }
  return row;
}

export async function getSwapRequest(actor, shopId, requestId) {
  await requireRotaEnabledScope(actor, shopId);
  const row = await getRequestOrThrow(shopId, requestId);
  return toResponse(row);
}

/**
 * The actual reassignment is delegated to rota.service.js's updateShift
 * rather than reimplemented here - it already does everything an approval
 * needs: confirms manage_rota, checks the new staff member is still active,
 * and (critically) re-checks for schedule overlap, since time has passed
 * between the request and this decision and the nominated colleague may
 * have picked up something else in the meantime.
 */
export async function approveSwapRequest(actor, shopId, requestId) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_ROTA, MANAGE_ROTA_MESSAGE);

  const request = await getRequestOrThrow(shopId, requestId);
  if (request.status !== 'pending') {
    throw new AppError('This swap request has already been decided', 409);
  }

  // Safety check: if the shift was reassigned some other way since the
  // request was made, don't silently overwrite that - surface it clearly.
  const shift = await rotaRepository.findActiveShiftByIdForShop(request.shift_id, shopId);
  if (!shift) {
    throw new AppError('The shift for this swap request no longer exists', 404);
  }
  if (shift.staff_id !== request.from_staff_id) {
    throw new AppError('This shift has already been reassigned since the swap was requested', 409);
  }

  await updateRotaShift(actor, shopId, request.shift_id, { staffId: request.to_staff_id });

  const decided = await swapRequestRepository.decide(requestId, 'approved', actor.type, actor.id);
  return toResponse(decided);
}

export async function rejectSwapRequest(actor, shopId, requestId) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  assertHasPermission(authority, PERMISSIONS.MANAGE_ROTA, MANAGE_ROTA_MESSAGE);

  const request = await getRequestOrThrow(shopId, requestId);
  if (request.status !== 'pending') {
    throw new AppError('This swap request has already been decided', 409);
  }

  const decided = await swapRequestRepository.decide(requestId, 'rejected', actor.type, actor.id);
  return toResponse(decided);
}
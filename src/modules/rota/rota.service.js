import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as shopRepository from '../shop/shop.repository.js';
import * as staffRepository from '../staff/staff.repository.js';
import * as rotaRepository from './rota.repository.js';

function toResponse(shift) {
  return {
    id: shift.id,
    staffId: shift.staff_id,
    startTime: shift.start_time,
    endTime: shift.end_time,
    notes: shift.notes,
    createdAt: shift.created_at,
    updatedAt: shift.updated_at,
  };
}

/**
 * Gate 1, applies to every rota endpoint including reads: the actor has
 * scope authority over this shop (404 otherwise, same convention as
 * everywhere else), AND rota is actually enabled for it (400 - a business
 * config gate, same status precedent as 2.3's "set business_type first").
 *
 * Exported so swapRequest.service.js (5.2) reuses this exact gate rather
 * than a near-duplicate - a swap request is fundamentally a rota operation.
 */
export async function requireRotaEnabledScope(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  const shop = await shopRepository.findActiveShopById(shopId);
  if (!shop || !shop.rota_enabled) {
    throw new AppError('Rota is not enabled for this shop', 400);
  }
  return authority;
}

/**
 * Gate 2, mutations only: the actor also has manage_rota. Deliberately NOT
 * required for reads - a Server has an obvious legitimate need to see the
 * rota (to know when they're working).
 */
function requireManageRota(authority) {
  assertHasPermission(authority, PERMISSIONS.MANAGE_ROTA, 'You do not have permission to manage the rota');
}

export async function createShift(actor, shopId, { staffId, startTime, endTime, notes }) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  requireManageRota(authority);

  const staff = await staffRepository.findActiveStaffByIdForShop(staffId, shopId);
  if (!staff) {
    throw new AppError('Staff member not found', 404);
  }

  if (await rotaRepository.hasOverlappingShift(staffId, startTime, endTime)) {
    throw new AppError('This staff member already has a shift that overlaps this time', 409);
  }

  const shift = await rotaRepository.createShift(staffId, { startTime, endTime, notes });
  return toResponse(shift);
}

export async function listShifts(actor, shopId, { from, to }) {
  await requireRotaEnabledScope(actor, shopId); // reads only need gate 1
  const shifts = await rotaRepository.listShiftsForShopInRange(shopId, from, to);
  return shifts.map(toResponse);
}

async function getShiftOrThrow(shopId, shiftId) {
  const shift = await rotaRepository.findActiveShiftByIdForShop(shiftId, shopId);
  if (!shift) {
    throw new AppError('Shift not found', 404);
  }
  return shift;
}

export async function getShift(actor, shopId, shiftId) {
  await requireRotaEnabledScope(actor, shopId);
  const shift = await getShiftOrThrow(shopId, shiftId);
  return toResponse(shift);
}

export async function updateShift(actor, shopId, shiftId, data) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  requireManageRota(authority);

  const existing = await getShiftOrThrow(shopId, shiftId);

  if (data.staffId) {
    const staff = await staffRepository.findActiveStaffByIdForShop(data.staffId, shopId);
    if (!staff) {
      throw new AppError('Staff member not found', 404);
    }
  }

  const targetStaffId = data.staffId ?? existing.staff_id;
  const newStart = data.startTime ?? existing.start_time;
  const newEnd = data.endTime ?? existing.end_time;
  if (newEnd <= newStart) {
    throw new AppError('endTime must be after startTime', 400);
  }

  if (await rotaRepository.hasOverlappingShift(targetStaffId, newStart, newEnd, shiftId)) {
    throw new AppError('This staff member already has a shift that overlaps this time', 409);
  }

  const updated = await rotaRepository.updateShift(shiftId, data);
  return toResponse(updated);
}

export async function deleteShift(actor, shopId, shiftId) {
  const authority = await requireRotaEnabledScope(actor, shopId);
  requireManageRota(authority);

  const existing = await getShiftOrThrow(shopId, shiftId);
  await rotaRepository.softDeleteShift(existing.id);
}
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { AppError } from '../../utils/AppError.js';
import { getMyShopOrThrow } from '../shop/shop.service.js';
import * as staffRepository from './staff.repository.js';

const PIN_SALT_ROUNDS = 12;
const POSTGRES_UNIQUE_VIOLATION = '23505';
const MAX_ID_CODE_ATTEMPTS = 5;

/**
 * 8 digits, zero-padded, using a cryptographically random number rather than
 * Math.random() - these identify and authenticate a real staff member.
 */
function generateEightDigitCode() {
  return crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
}

function toResponse(staff) {
  return {
    id: staff.id,
    shopId: staff.shop_id,
    fullName: staff.full_name,
    role: staff.role,
    staffIdCode: staff.staff_id_code,
    createdAt: staff.created_at,
    updatedAt: staff.updated_at,
  };
}

export async function createStaffForShop(ownerUserId, shopId, { fullName, role }) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);

  const rawPin = generateEightDigitCode();
  const pinHash = await bcrypt.hash(rawPin, PIN_SALT_ROUNDS);

  let staff;
  for (let attempt = 1; ; attempt += 1) {
    const staffIdCode = generateEightDigitCode();
    try {
      staff = await staffRepository.createStaff(shop.id, {
        fullName,
        role,
        staffIdCode,
        pinHash,
      });
      break;
    } catch (err) {
      // A collision on an 8-digit code is astronomically unlikely - this is
      // just a defensive retry, not something expected to actually fire.
      if (err.code === POSTGRES_UNIQUE_VIOLATION && attempt < MAX_ID_CODE_ATTEMPTS) {
        continue;
      }
      if (err.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new AppError('Failed to generate a unique staff ID - please try again', 500);
      }
      throw err;
    }
  }

  return {
    ...toResponse(staff),
    // One-time reveal, same principle as verification tokens - the raw PIN
    // is never retrievable again after this response.
    pin: rawPin,
  };
}

export async function listStaffForShop(ownerUserId, shopId) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const staff = await staffRepository.listActiveStaffForShop(shop.id);
  return staff.map(toResponse);
}

async function getStaffOrThrow(ownerUserId, shopId, staffId) {
  const shop = await getMyShopOrThrow(ownerUserId, shopId);
  const staff = await staffRepository.findActiveStaffByIdForShop(staffId, shop.id);
  if (!staff) {
    throw new AppError('Staff member not found', 404);
  }
  return staff;
}

export async function getStaffMember(ownerUserId, shopId, staffId) {
  const staff = await getStaffOrThrow(ownerUserId, shopId, staffId);
  return toResponse(staff);
}

export async function updateStaffMember(ownerUserId, shopId, staffId, data) {
  await getStaffOrThrow(ownerUserId, shopId, staffId);
  const updated = await staffRepository.updateStaff(staffId, data);
  return toResponse(updated);
}

export async function deactivateStaffMember(ownerUserId, shopId, staffId) {
  const staff = await getStaffOrThrow(ownerUserId, shopId, staffId);
  await staffRepository.softDeleteStaff(staff.id);
  // NOTE (Module 4.3 dependency): once staff PIN sessions exist, deactivating
  // a staff member should also invalidate any active session. No session
  // concept exists yet to hook into.
}
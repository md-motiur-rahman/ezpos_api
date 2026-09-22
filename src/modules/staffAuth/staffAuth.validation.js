import { z } from 'zod';

// `shopId` was REMOVED from this contract (was required before) - a
// deliberate reversal, not a leftover from an earlier draft. Staff login no
// longer needs a caller-supplied shop: staffAuth.service.js's own `login`
// resolves it by trying every shop whose staff_id_code matches and letting
// the PIN be the actual disambiguator (staff_id_code is only unique PER
// SHOP - a partial index on (shop_id, staff_id_code), confirmed reading the
// staff table's own migration directly - so the code alone can't resolve a
// shop on its own). See that function's own doc for why checking the PIN
// against every candidate is safe, not just convenient.
export const staffLoginSchema = z.object({
  staffIdCode: z.string().regex(/^\d{8}$/, 'Staff ID must be 8 digits'),
  pin: z.string().regex(/^\d{8}$/, 'PIN must be 8 digits'),
});

export const staffLogoutSchema = z.object({
  sessionToken: z.string().min(1, 'sessionToken is required'),
});

// Self-service PIN change (a staff member changing their OWN pin, via an
// already-authenticated session - see `requireStaffAuth` on this route).
// Mirrors `auth.validation.js`'s own `changePasswordSchema` shape exactly:
// current value required to prove it's really them, new value validated to
// the same 8-digit format `staffLoginSchema` itself enforces.
export const changePinSchema = z.object({
  currentPin: z.string().regex(/^\d{8}$/, 'Current PIN must be 8 digits'),
  newPin: z.string().regex(/^\d{8}$/, 'New PIN must be 8 digits'),
});
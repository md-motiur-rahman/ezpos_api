import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, staff_id, start_time, end_time, notes, created_at, updated_at`;

export async function createShift(staffId, { startTime, endTime, notes }) {
  const { rows } = await query(
    `INSERT INTO rota_shifts (staff_id, start_time, end_time, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [staffId, startTime, endTime, notes ?? null]
  );
  return rows[0];
}

/**
 * Shop-scoped via JOIN staff (rota_shifts has no shop_id of its own - see
 * the migration). Range-filtered by overlap with [from, to), not strict
 * containment, so a shift that only partially falls in the window still
 * shows up.
 */
export async function listShiftsForShopInRange(shopId, from, to) {
  const { rows } = await query(
    `SELECT rs.id, rs.staff_id, rs.start_time, rs.end_time, rs.notes, rs.created_at, rs.updated_at
     FROM rota_shifts rs
     JOIN staff s ON s.id = rs.staff_id
     WHERE s.shop_id = $1 AND rs.deleted_at IS NULL
       AND rs.start_time < $3 AND rs.end_time > $2
     ORDER BY rs.start_time`,
    [shopId, from, to]
  );
  return rows;
}

export async function findActiveShiftByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT rs.id, rs.staff_id, rs.start_time, rs.end_time, rs.notes, rs.created_at, rs.updated_at
     FROM rota_shifts rs
     JOIN staff s ON s.id = rs.staff_id
     WHERE rs.id = $1 AND s.shop_id = $2 AND rs.deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

/**
 * Standard half-open interval overlap check. excludeShiftId lets an update
 * ignore the shift's own existing row when re-checking after a time change.
 */
export async function hasOverlappingShift(staffId, startTime, endTime, excludeShiftId = null) {
  const { rows } = await query(
    `SELECT id FROM rota_shifts
     WHERE staff_id = $1 AND deleted_at IS NULL
       AND start_time < $3 AND end_time > $2
       AND ($4::uuid IS NULL OR id != $4)
     LIMIT 1`,
    [staffId, startTime, endTime, excludeShiftId]
  );
  return rows.length > 0;
}

export async function updateShift(id, data) {
  const fieldMap = {
    staffId: 'staff_id',
    startTime: 'start_time',
    endTime: 'end_time',
    notes: 'notes',
  };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE rota_shifts SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteShift(id) {
  await query(`UPDATE rota_shifts SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
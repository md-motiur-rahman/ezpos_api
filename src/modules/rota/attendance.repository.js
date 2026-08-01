import { query } from '../../db/pool.js';

const COLUMNS = `id, staff_id, clocked_in_at, clocked_out_at, created_at`;

export async function clockIn(staffId) {
  const { rows } = await query(
    `INSERT INTO attendance_records (staff_id, clocked_in_at) VALUES ($1, now()) RETURNING ${COLUMNS}`,
    [staffId]
  );
  return rows[0];
}

export async function findOpenRecordForStaff(staffId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM attendance_records WHERE staff_id = $1 AND clocked_out_at IS NULL`,
    [staffId]
  );
  return rows[0] ?? null;
}

export async function clockOut(id) {
  const { rows } = await query(
    `UPDATE attendance_records SET clocked_out_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
    [id]
  );
  return rows[0];
}

/**
 * Shop-scoped via JOIN staff. Range-filtered by overlap - unlike rota_shifts,
 * clocked_out_at can be NULL (still open), so an open record overlaps
 * anything up to and including "now".
 */
export async function listForShopInRange(shopId, from, to, staffId = null) {
  const params = [shopId, from, to];
  let staffClause = '';
  if (staffId) {
    params.push(staffId);
    staffClause = `AND ar.staff_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT ar.id, ar.staff_id, ar.clocked_in_at, ar.clocked_out_at, ar.created_at
     FROM attendance_records ar
     JOIN staff s ON s.id = ar.staff_id
     WHERE s.shop_id = $1
       AND ar.clocked_in_at < $3
       AND (ar.clocked_out_at IS NULL OR ar.clocked_out_at > $2)
       ${staffClause}
     ORDER BY ar.clocked_in_at`,
    params
  );
  return rows;
}

export async function findByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ar.id, ar.staff_id, ar.clocked_in_at, ar.clocked_out_at, ar.created_at
     FROM attendance_records ar
     JOIN staff s ON s.id = ar.staff_id
     WHERE ar.id = $1 AND s.shop_id = $2`,
    [id, shopId]
  );
  return rows[0] ?? null;
}
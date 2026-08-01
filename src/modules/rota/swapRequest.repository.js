import { query } from '../../db/pool.js';

const COLUMNS = `id, shift_id, from_staff_id, to_staff_id, requested_by_type, requested_by_id,
                 status, decided_by_type, decided_by_id, decided_at, notes, created_at`;

/** Throws Postgres unique-violation (23505) if a pending request already exists for this shift. */
export async function create({ shiftId, fromStaffId, toStaffId, requestedByType, requestedById, notes }) {
  const { rows } = await query(
    `INSERT INTO shift_swap_requests
       (shift_id, from_staff_id, to_staff_id, requested_by_type, requested_by_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [shiftId, fromStaffId, toStaffId, requestedByType, requestedById, notes ?? null]
  );
  return rows[0];
}

/**
 * Shop-scoped via JOIN rota_shifts -> staff. Excludes requests whose
 * underlying shift has since been soft-deleted - a request for a shift that
 * no longer exists isn't meaningful to show.
 */
export async function listForShop(shopId, status) {
  const params = [shopId];
  let statusClause = '';
  if (status) {
    params.push(status);
    statusClause = `AND ssr.status = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT ssr.id, ssr.shift_id, ssr.from_staff_id, ssr.to_staff_id, ssr.requested_by_type,
            ssr.requested_by_id, ssr.status, ssr.decided_by_type, ssr.decided_by_id,
            ssr.decided_at, ssr.notes, ssr.created_at
     FROM shift_swap_requests ssr
     JOIN rota_shifts rs ON rs.id = ssr.shift_id AND rs.deleted_at IS NULL
     JOIN staff s ON s.id = rs.staff_id
     WHERE s.shop_id = $1 ${statusClause}
     ORDER BY ssr.created_at DESC`,
    params
  );
  return rows;
}

export async function findByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ssr.id, ssr.shift_id, ssr.from_staff_id, ssr.to_staff_id, ssr.requested_by_type,
            ssr.requested_by_id, ssr.status, ssr.decided_by_type, ssr.decided_by_id,
            ssr.decided_at, ssr.notes, ssr.created_at
     FROM shift_swap_requests ssr
     JOIN rota_shifts rs ON rs.id = ssr.shift_id AND rs.deleted_at IS NULL
     JOIN staff s ON s.id = rs.staff_id
     WHERE ssr.id = $1 AND s.shop_id = $2`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function decide(id, status, decidedByType, decidedById) {
  const { rows } = await query(
    `UPDATE shift_swap_requests
     SET status = $1, decided_by_type = $2, decided_by_id = $3, decided_at = now()
     WHERE id = $4
     RETURNING ${COLUMNS}`,
    [status, decidedByType, decidedById, id]
  );
  return rows[0];
}
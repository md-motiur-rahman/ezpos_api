import { query } from '../../db/pool.js';

const SCAN_COLUMNS = `s.id, s.shop_id, s.inventory_item_id, s.sku, s.state,
                      s.shelf_life_days_used, s.scanned_at, s.expires_on,
                      s.created_at, s.updated_at`;

// Joined for the item's name/unit only (display purposes) - deliberately
// NOT quantity_on_hand or low_stock_threshold. This endpoint is gated on
// PERFORM_HEALTH_SAFETY (8.2), a broader permission than VIEW_INVENTORY, so
// pulling stock-level fields through here would leak back-of-house data to
// roles (Server, Shift Manager) who don't otherwise have it by default.
const ITEM_JOIN = `JOIN inventory_items ii ON ii.id = s.inventory_item_id`;

/**
 * Immutable once created (8.2) - no update/delete function exists here at
 * all, same as 7.6's receipts and 7.7's wastage logs. `expires_on` is
 * computed by the service layer (today + whichever shelf-life duration
 * applied) and passed in already calculated, not derived in SQL - the
 * calculation itself has no DB-specific behavior worth pushing down.
 */
export async function createScan(
  shopId,
  { inventoryItemId, sku, state, shelfLifeDaysUsed, expiresOn }
) {
  const { rows } = await query(
    `WITH inserted AS (
       INSERT INTO inventory_item_scans
         (shop_id, inventory_item_id, sku, state, shelf_life_days_used, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inserted s
     ${ITEM_JOIN}`,
    [shopId, inventoryItemId, sku, state, shelfLifeDaysUsed, expiresOn]
  );
  return rows[0];
}

export async function listScansForShop(shopId) {
  const { rows } = await query(
    `SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inventory_item_scans s
     ${ITEM_JOIN}
     WHERE s.shop_id = $1
     ORDER BY s.scanned_at DESC`,
    [shopId]
  );
  return rows;
}

export async function findScanByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inventory_item_scans s
     ${ITEM_JOIN}
     WHERE s.id = $1 AND s.shop_id = $2`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

/**
 * One row per inventory item that has been scanned at least once - only
 * the MOST RECENT scan for each, via DISTINCT ON (verified empirically
 * that this picks the truly latest by scanned_at, not insertion order,
 * before this query was relied on). Postgres requires ORDER BY's leading
 * expression(s) to match DISTINCT ON's - inventory_item_id first, then
 * scanned_at DESC picks the winner within each group. Items never scanned
 * don't appear - this is scan-HISTORY status (8.3), not a shelf-life-
 * configuration listing (that's 8.1's job).
 */
export async function listLatestScansForShop(shopId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (s.inventory_item_id)
            ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
     FROM inventory_item_scans s
     ${ITEM_JOIN}
     WHERE s.shop_id = $1
     ORDER BY s.inventory_item_id, s.scanned_at DESC`,
    [shopId]
  );
  return rows;
}

// --- Print log (8.3) ---

const PRINT_COLUMNS = `id, scan_id, shop_id, printed_at, created_at, updated_at`;

/**
 * Immutable once created, same as the scan itself - no update/delete
 * function exists here at all. Each call is a NEW row, deliberately - a
 * damaged label just gets reprinted, and the history of every print stays
 * visible rather than being overwritten (same "multiple receipts per PO"
 * precedent as 7.6).
 */
export async function createPrint(shopId, scanId) {
  const { rows } = await query(
    `INSERT INTO inventory_item_scan_prints (shop_id, scan_id)
     VALUES ($1, $2)
     RETURNING ${PRINT_COLUMNS}`,
    [shopId, scanId]
  );
  return rows[0];
}

export async function listPrintsForScan(scanId, shopId) {
  const { rows } = await query(
    `SELECT ${PRINT_COLUMNS} FROM inventory_item_scan_prints
     WHERE scan_id = $1 AND shop_id = $2
     ORDER BY printed_at DESC`,
    [scanId, shopId]
  );
  return rows;
}

// --- Auto-flagging (8.4) ---

/**
 * The "auto-flagged" list: one row per item whose MOST RECENT scan has
 * passed its expires_on and has no resolution yet. The latest-per-item
 * pick happens in the `latest` CTE FIRST, then expiry/resolution filtering
 * applies to that result - NOT the other way around. Verified empirically
 * before this was relied on: filtering `expires_on <= today` before the
 * DISTINCT ON would pick an item's most recent EXPIRED scan even when a
 * newer, non-expired rescan of the same item exists and should supersede
 * it. `today` is passed in as a parameter (a 'YYYY-MM-DD' string computed
 * the same UTC-calendar way as 8.2's expires_on) rather than compared
 * against Postgres's own CURRENT_DATE, so there's exactly one definition
 * of "today" behind both the calculation (8.2) and this check, not two
 * that could silently drift apart across server/DB timezone settings.
 */
export async function listExpiredUnresolvedScansForShop(shopId, todayUtcDateString) {
  const { rows } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (s.inventory_item_id)
              ${SCAN_COLUMNS}, ii.name AS item_name, ii.unit AS item_unit
       FROM inventory_item_scans s
       ${ITEM_JOIN}
       WHERE s.shop_id = $1
       ORDER BY s.inventory_item_id, s.scanned_at DESC
     )
     SELECT latest.*
     FROM latest
     LEFT JOIN inventory_item_scan_resolutions r ON r.scan_id = latest.id
     WHERE latest.expires_on <= $2 AND r.id IS NULL
     ORDER BY latest.expires_on ASC`,
    [shopId, todayUtcDateString]
  );
  return rows;
}

// --- Resolutions (8.4) ---

const RESOLUTION_COLUMNS = `id, scan_id, shop_id, wastage_log_id, notes, resolved_at, created_at, updated_at`;

/**
 * Immutable once created - no update/delete function here either, same
 * "already-applied event" reasoning as the scan and print tables. The
 * unique constraint on scan_id (one resolution per scan) is enforced by
 * the DB; the service layer catches the 23505 and turns it into a 409,
 * same established pattern as every other unique-constraint case in this
 * project (7.4's supplier links, 8.2's sku).
 */
export async function createResolution(shopId, { scanId, wastageLogId, notes }) {
  const { rows } = await query(
    `INSERT INTO inventory_item_scan_resolutions (scan_id, shop_id, wastage_log_id, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING ${RESOLUTION_COLUMNS}`,
    [scanId, shopId, wastageLogId ?? null, notes ?? null]
  );
  return rows[0];
}

export async function findResolutionByScanId(scanId, shopId) {
  const { rows } = await query(
    `SELECT ${RESOLUTION_COLUMNS} FROM inventory_item_scan_resolutions
     WHERE scan_id = $1 AND shop_id = $2`,
    [scanId, shopId]
  );
  return rows[0] ?? null;
}

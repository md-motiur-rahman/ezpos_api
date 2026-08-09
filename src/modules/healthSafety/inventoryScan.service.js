import { AppError } from '../../utils/AppError.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { resolveActorAuthority, assertHasPermission } from '../staff/actorAuthority.js';
import * as inventoryRepository from '../inventory/inventory.repository.js';
import * as scanRepository from './inventoryScan.repository.js';

/**
 * Deliberately PERFORM_HEALTH_SAFETY, not VIEW_INVENTORY - confirmed
 * directly. Broadly available by default (Manager, Shift Manager, Server,
 * Chef all have it), matching that scanning/labeling for expiry is a
 * floor-staff health & safety task, not a stock-management one - the same
 * framing as Module 8 itself. Reading and creating share one gate, same
 * precedent as 7.7's wastage logs.
 */
async function requirePerformHealthSafety(actor, shopId) {
  const authority = await resolveActorAuthority(actor, shopId);
  assertHasPermission(
    authority,
    PERMISSIONS.PERFORM_HEALTH_SAFETY,
    'You do not have permission to perform health & safety actions'
  );
  return authority;
}

/**
 * pg parses a `date` column as a JS Date at LOCAL midnight (not UTC
 * midnight) - verified empirically, and it matters: server timezone here is
 * Europe/London, so during BST (UTC+1) a stored '2026-08-23' comes back as
 * 2026-08-22T23:00:00Z. Reading it with .toISOString() would silently
 * re-render it as the PREVIOUS day. Formatting with LOCAL getters instead
 * (not UTC getters) recovers the original calendar date correctly,
 * regardless of server timezone - this is the first `date` (as opposed to
 * `timestamptz`) column in the schema, so this bug class didn't exist
 * anywhere else in the project before 8.2.
 */
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toResponse(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    inventoryItemId: row.inventory_item_id,
    itemName: row.item_name,
    unit: row.item_unit,
    sku: row.sku,
    state: row.state,
    shelfLifeDaysUsed: row.shelf_life_days_used,
    scannedAt: row.scanned_at,
    expiresOn: formatLocalDate(row.expires_on),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * today + N days, computed in UTC calendar terms (stable regardless of
 * server timezone) and formatted back out with formatLocalDate - safe
 * specifically because todayUtc is constructed from UTC getters AND
 * consumed as a plain calendar date (year/month/day), never compared
 * against a wall-clock time. The asymmetry with formatLocalDate above is
 * deliberate: this function builds a calendar date from scratch (no
 * round-trip through pg's local-midnight parsing), that one recovers one
 * that pg already parsed as local midnight.
 */
function calculateExpiresOn(shelfLifeDays) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = new Date(todayUtc + shelfLifeDays * MS_PER_DAY);
  const year = target.getUTCFullYear();
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function createScan(actor, shopId, { sku, state }) {
  await requirePerformHealthSafety(actor, shopId);

  const item = await inventoryRepository.findActiveItemBySkuForShop(sku, shopId);
  if (!item) {
    throw new AppError('No inventory item found for this SKU', 404);
  }

  const shelfLifeDays = state === 'sealed' ? item.shelf_life_days : item.shelf_life_opened_days;
  if (shelfLifeDays === null) {
    throw new AppError(
      `This item has no shelf life configured for state '${state}'`,
      400
    );
  }

  const scan = await scanRepository.createScan(shopId, {
    inventoryItemId: item.id,
    sku,
    state,
    shelfLifeDaysUsed: shelfLifeDays,
    expiresOn: calculateExpiresOn(shelfLifeDays),
  });
  return toResponse(scan);
}

export async function listScans(actor, shopId) {
  await requirePerformHealthSafety(actor, shopId);
  const scans = await scanRepository.listScansForShop(shopId);
  return scans.map(toResponse);
}

export async function getScan(actor, shopId, scanId) {
  await requirePerformHealthSafety(actor, shopId);
  const scan = await scanRepository.findScanByIdForShop(scanId, shopId);
  if (!scan) {
    throw new AppError('Scan not found', 404);
  }
  return toResponse(scan);
}

/**
 * One row per item that has been scanned at least once, showing only its
 * most recent scan (8.3) - same permission gate and response shape as
 * every other read here, just a different repository query underneath.
 */
export async function listLatestScans(actor, shopId) {
  await requirePerformHealthSafety(actor, shopId);
  const scans = await scanRepository.listLatestScansForShop(shopId);
  return scans.map(toResponse);
}

// --- Print log (8.3) ---

async function getScanOrThrow(shopId, scanId) {
  const scan = await scanRepository.findScanByIdForShop(scanId, shopId);
  if (!scan) {
    throw new AppError('Scan not found', 404);
  }
  return scan;
}

function toPrintResponse(printRow, scan) {
  return {
    id: printRow.id,
    scanId: printRow.scan_id,
    printedAt: printRow.printed_at,
    // A deliberately NARROW subset of the scan - exactly what belongs on a
    // physical label, not the full scan record (no id/state/scannedAt
    // clutter). Reuses toResponse's already-correct date formatting rather
    // than re-deriving it.
    label: {
      itemName: scan.itemName,
      sku: scan.sku,
      expiresOn: scan.expiresOn,
    },
  };
}

/**
 * Same PERFORM_HEALTH_SAFETY gate as everything else in this module - not a
 * new decision, just consistent with 8.2. Each call creates a NEW print
 * row (see inventoryScan.repository.js) - reprinting is not an error, it's
 * the expected way to replace a damaged label.
 */
export async function triggerPrint(actor, shopId, scanId) {
  await requirePerformHealthSafety(actor, shopId);
  const scan = await getScanOrThrow(shopId, scanId);

  const printRow = await scanRepository.createPrint(shopId, scanId);
  return toPrintResponse(printRow, toResponse(scan));
}

export async function listPrints(actor, shopId, scanId) {
  await requirePerformHealthSafety(actor, shopId);
  const scan = await getScanOrThrow(shopId, scanId);
  const response = toResponse(scan);

  const prints = await scanRepository.listPrintsForScan(scanId, shopId);
  return prints.map((printRow) => toPrintResponse(printRow, response));
}

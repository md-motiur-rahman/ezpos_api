import { query } from '../../db/pool.js';
import { buildUpdateSet, detachRelationship } from '../../utils/sql.js';

const COLUMNS = `id, shop_id, name, unit, quantity_on_hand, low_stock_threshold, created_at, updated_at`;

export async function createItem(shopId, { name, unit, quantityOnHand, lowStockThreshold }) {
  const { rows } = await query(
    `INSERT INTO inventory_items (shop_id, name, unit, quantity_on_hand, low_stock_threshold)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [shopId, name, unit, quantityOnHand ?? 0, lowStockThreshold ?? null]
  );
  return rows[0];
}

/**
 * lowStockOnly filters in SQL (not fetch-then-filter in JS) - a plain WHERE
 * clause addition, not the kind of aggregation that benefited from being
 * pushed to Postgres in 6.5's allergen union; here it's simpler to just not
 * fetch rows the caller doesn't want.
 */
export async function listActiveItemsForShop(shopId, { lowStockOnly } = {}) {
  const lowStockClause = lowStockOnly
    ? 'AND low_stock_threshold IS NOT NULL AND quantity_on_hand <= low_stock_threshold'
    : '';
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM inventory_items
     WHERE shop_id = $1 AND deleted_at IS NULL
       ${lowStockClause}
     ORDER BY name`,
    [shopId]
  );
  return rows;
}

export async function findActiveItemByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM inventory_items
     WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function updateItem(id, data) {
  const fieldMap = {
    name: 'name',
    unit: 'unit',
    quantityOnHand: 'quantity_on_hand',
    lowStockThreshold: 'low_stock_threshold',
  };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE inventory_items SET ${clause} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteItem(id) {
  await query(`UPDATE inventory_items SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

// --- Item <-> supplier linking (7.4) ---

const SUPPLIER_LINK_COLUMNS = `id, inventory_item_id, supplier_id, is_default, created_at, updated_at`;

/**
 * Throws Postgres unique-violation (23505) if this supplier is already
 * attached to this item. If isDefault is true, unsets any existing default
 * for the item first, as a SEPARATE statement before the INSERT - not
 * combined into one CTE. Verified empirically that a same-statement CTE
 * swap can trip the partial unique index (inventory_item_suppliers_
 * one_default_per_item) mid-statement, since Postgres checks a unique
 * INDEX (unlike a deferrable CONSTRAINT, which can't express partial
 * uniqueness at all) per-row as it's written, not deferred to statement
 * end - even within a single WITH-clause statement.
 */
export async function attachSupplierToItem(itemId, supplierId, isDefault) {
  if (isDefault) {
    await query(
      `UPDATE inventory_item_suppliers SET is_default = false, updated_at = now()
       WHERE inventory_item_id = $1 AND is_default = true`,
      [itemId]
    );
  }
  const { rows } = await query(
    `INSERT INTO inventory_item_suppliers (inventory_item_id, supplier_id, is_default)
     VALUES ($1, $2, $3)
     RETURNING ${SUPPLIER_LINK_COLUMNS}`,
    [itemId, supplierId, isDefault ?? false]
  );
  return rows[0];
}

/** Makes this supplier the default for the item, unsetting any other default first. Returns null if not attached. */
export async function setSupplierAsDefaultForItem(itemId, supplierId) {
  await query(
    `UPDATE inventory_item_suppliers SET is_default = false, updated_at = now()
     WHERE inventory_item_id = $1 AND supplier_id != $2 AND is_default = true`,
    [itemId, supplierId]
  );
  const { rows } = await query(
    `UPDATE inventory_item_suppliers SET is_default = true, updated_at = now()
     WHERE inventory_item_id = $1 AND supplier_id = $2
     RETURNING ${SUPPLIER_LINK_COLUMNS}`,
    [itemId, supplierId]
  );
  return rows[0] ?? null;
}

/** Unsets this supplier as default, leaving the item with no default. Returns null if not attached. */
export async function unsetSupplierAsDefaultForItem(itemId, supplierId) {
  const { rows } = await query(
    `UPDATE inventory_item_suppliers SET is_default = false, updated_at = now()
     WHERE inventory_item_id = $1 AND supplier_id = $2
     RETURNING ${SUPPLIER_LINK_COLUMNS}`,
    [itemId, supplierId]
  );
  return rows[0] ?? null;
}

export async function detachSupplierFromItem(itemId, supplierId) {
  return detachRelationship(
    'inventory_item_suppliers',
    'inventory_item_id',
    itemId,
    'supplier_id',
    supplierId
  );
}

/** Each row is the supplier's own fields plus whether it's this item's default. */
export async function listSuppliersForItem(itemId) {
  const { rows } = await query(
    `SELECT s.id, s.shop_id, s.name, s.contact_name, s.phone, s.email, s.notes,
            s.created_at, s.updated_at, iis.is_default
     FROM inventory_item_suppliers iis
     JOIN suppliers s ON s.id = iis.supplier_id AND s.deleted_at IS NULL
     WHERE iis.inventory_item_id = $1
     ORDER BY iis.is_default DESC, s.name`,
    [itemId]
  );
  return rows;
}

// --- Bulk operations shared across modules (7.6/7.7) ---

/**
 * Bulk fetch, scoped to the shop - serves two purposes: validating that
 * every referenced id actually belongs to this shop (compare the returned
 * row count to itemIds.length), and giving the CURRENT quantityOnHand for
 * each, needed before a stock-decreasing operation like wastage can check
 * "is there enough to waste this much" before writing anything.
 */
export async function findActiveItemsByIdsForShop(shopId, itemIds) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM inventory_items
     WHERE id = ANY($1::uuid[]) AND shop_id = $2 AND deleted_at IS NULL`,
    [itemIds, shopId]
  );
  return rows;
}

// --- Cross-shop overview (7.8) ---

/**
 * Every active item across every active shop in the company, joined for the
 * shop's name (needed to label rows in the overview response) and scoped by
 * shops.company_id rather than a single shop_id - the one place in this
 * module reads deliberately span shops, for the chain-owner "all locations"
 * view. Same lowStockOnly clause shape as listActiveItemsForShop (7.3).
 */
export async function listActiveItemsForCompany(companyId, { lowStockOnly } = {}) {
  const lowStockClause = lowStockOnly
    ? 'AND ii.low_stock_threshold IS NOT NULL AND ii.quantity_on_hand <= ii.low_stock_threshold'
    : '';
  const { rows } = await query(
    `SELECT ii.id, ii.shop_id, s.name AS shop_name, ii.name, ii.unit,
            ii.quantity_on_hand, ii.low_stock_threshold, ii.created_at, ii.updated_at
     FROM inventory_items ii
     JOIN shops s ON s.id = ii.shop_id AND s.deleted_at IS NULL
     WHERE s.company_id = $1 AND ii.deleted_at IS NULL
       ${lowStockClause}
     ORDER BY s.name, ii.name`,
    [companyId]
  );
  return rows;
}

/**
 * Bulk stock adjustment via UPDATE...FROM unnest() - one atomic statement
 * for every affected item, regardless of how many are adjusted at once.
 * Relocated here from purchaseOrder.repository.js (7.7) - originally built
 * for receiving (7.6, always positive amounts), now shared with wastage
 * (always negative amounts) - genuinely the same mechanism either way,
 * `quantity_on_hand + amount` handles both directions. Renamed from
 * "increment" to "adjust" since that name would be misleading once used for
 * decrements too. Verified empirically (7.6) that repeated calls against
 * the same item correctly accumulate rather than overwrite.
 */
export async function adjustInventoryQuantities(inventoryItemIds, amounts) {
  await query(
    `UPDATE inventory_items
     SET quantity_on_hand = quantity_on_hand + delta.amount, updated_at = now()
     FROM (SELECT unnest($1::uuid[]) AS item_id, unnest($2::numeric[]) AS amount) AS delta
     WHERE inventory_items.id = delta.item_id`,
    [inventoryItemIds, amounts]
  );

  
}
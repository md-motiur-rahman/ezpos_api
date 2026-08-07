import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

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
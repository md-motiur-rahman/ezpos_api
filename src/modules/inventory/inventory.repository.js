import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const COLUMNS = `id, shop_id, name, unit, quantity_on_hand, created_at, updated_at`;

export async function createItem(shopId, { name, unit, quantityOnHand }) {
  const { rows } = await query(
    `INSERT INTO inventory_items (shop_id, name, unit, quantity_on_hand)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [shopId, name, unit, quantityOnHand ?? 0]
  );
  return rows[0];
}

export async function listActiveItemsForShop(shopId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM inventory_items
     WHERE shop_id = $1 AND deleted_at IS NULL
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
  const fieldMap = { name: 'name', unit: 'unit', quantityOnHand: 'quantity_on_hand' };
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
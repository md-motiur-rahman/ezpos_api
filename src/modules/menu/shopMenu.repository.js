import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const OVERRIDE_COLUMNS = `id, shop_id, menu_item_id, is_enabled, price_override, created_at, updated_at`;
const LOCAL_ITEM_COLUMNS = `id, shop_id, category_id, name, description, price, display_order, created_at, updated_at`;

// --- Overrides ---

/**
 * Native Postgres UPSERT (INSERT ... ON CONFLICT ... DO UPDATE) rather than
 * hand-rolled "look it up, then insert-or-update" application logic - the
 * unique constraint on (shop_id, menu_item_id) makes this the natural tool
 * for the job. Only the field(s) actually provided in this call are changed;
 * an omitted field keeps its current value on conflict (or the column
 * default on first insert) via COALESCE. Fully clearing an override back to
 * master defaults is DELETE's job, not this - so this never needs to
 * distinguish "clear this field" from "don't touch it".
 */
export async function upsertOverride(shopId, menuItemId, { isEnabled, priceOverride }) {
  const { rows } = await query(
    `INSERT INTO shop_menu_item_overrides (shop_id, menu_item_id, is_enabled, price_override)
     VALUES ($1, $2, COALESCE($3, true), $4)
     ON CONFLICT (shop_id, menu_item_id) DO UPDATE
       SET is_enabled = COALESCE($3, shop_menu_item_overrides.is_enabled),
           price_override = COALESCE($4, shop_menu_item_overrides.price_override),
           updated_at = now()
     RETURNING ${OVERRIDE_COLUMNS}`,
    [shopId, menuItemId, isEnabled ?? null, priceOverride ?? null]
  );
  return rows[0];
}

export async function deleteOverride(shopId, menuItemId) {
  await query(`DELETE FROM shop_menu_item_overrides WHERE shop_id = $1 AND menu_item_id = $2`, [
    shopId,
    menuItemId,
  ]);
}

/**
 * The resolved view: every active master item for the company, LEFT JOINed
 * against this shop's override (if any). COALESCE supplies master defaults
 * whenever no override row exists - a single query, not N+1 lookups or
 * app-level merging.
 */
export async function listResolvedMasterItemsForShop(shopId, companyId) {
  const { rows } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.display_order,
            mi.price AS master_price,
            COALESCE(smo.price_override, mi.price) AS effective_price,
            COALESCE(smo.is_enabled, true) AS is_enabled
     FROM menu_items mi
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     LEFT JOIN shop_menu_item_overrides smo ON smo.menu_item_id = mi.id AND smo.shop_id = $1
     WHERE mc.company_id = $2 AND mi.deleted_at IS NULL
     ORDER BY mi.display_order, mi.name`,
    [shopId, companyId]
  );
  return rows;
}

// --- Local (shop-exclusive) items ---

export async function createLocalItem(shopId, { categoryId, name, description, price, displayOrder }) {
  const { rows } = await query(
    `INSERT INTO shop_menu_items (shop_id, category_id, name, description, price, display_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${LOCAL_ITEM_COLUMNS}`,
    [shopId, categoryId, name, description ?? null, price, displayOrder ?? 0]
  );
  return rows[0];
}

export async function listActiveLocalItemsForShop(shopId) {
  const { rows } = await query(
    `SELECT ${LOCAL_ITEM_COLUMNS} FROM shop_menu_items
     WHERE shop_id = $1 AND deleted_at IS NULL
     ORDER BY display_order, name`,
    [shopId]
  );
  return rows;
}

export async function findActiveLocalItemByIdForShop(id, shopId) {
  const { rows } = await query(
    `SELECT ${LOCAL_ITEM_COLUMNS} FROM shop_menu_items
     WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL`,
    [id, shopId]
  );
  return rows[0] ?? null;
}

export async function updateLocalItem(id, data) {
  const fieldMap = {
    categoryId: 'category_id',
    name: 'name',
    description: 'description',
    price: 'price',
    displayOrder: 'display_order',
  };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE shop_menu_items SET ${clause} WHERE id = $${values.length} RETURNING ${LOCAL_ITEM_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteLocalItem(id) {
  await query(`UPDATE shop_menu_items SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}
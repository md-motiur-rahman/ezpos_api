import { query } from '../../db/pool.js';
import { buildUpdateSet } from '../../utils/sql.js';

const CATEGORY_COLUMNS = `id, company_id, name, display_order, is_active, created_at, updated_at`;
const ITEM_COLUMNS = `id, category_id, name, description, price, display_order, created_at, updated_at`;

// --- Categories ---

export async function createCategory(companyId, { name, displayOrder }) {
  const { rows } = await query(
    `INSERT INTO menu_categories (company_id, name, display_order)
     VALUES ($1, $2, $3)
     RETURNING ${CATEGORY_COLUMNS}`,
    [companyId, name, displayOrder ?? 0]
  );
  return rows[0];
}

export async function listActiveCategoriesForCompany(companyId) {
  const { rows } = await query(
    `SELECT ${CATEGORY_COLUMNS} FROM menu_categories
     WHERE company_id = $1 AND deleted_at IS NULL
     ORDER BY display_order, name`,
    [companyId]
  );
  return rows;
}

export async function findActiveCategoryByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT ${CATEGORY_COLUMNS} FROM menu_categories
     WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateCategory(id, data) {
  const fieldMap = { name: 'name', displayOrder: 'display_order', isActive: 'is_active' };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE menu_categories SET ${clause} WHERE id = $${values.length} RETURNING ${CATEGORY_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteCategory(id) {
  await query(`UPDATE menu_categories SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

/** Used to block deleting a category that still has any (non-deleted) items. */
export async function countActiveItemsInCategory(categoryId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM menu_items WHERE category_id = $1 AND deleted_at IS NULL`,
    [categoryId]
  );
  return rows[0].count;
}

// --- Items ---

export async function createItem(categoryId, { name, description, price, displayOrder }) {
  const { rows } = await query(
    `INSERT INTO menu_items (category_id, name, description, price, display_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ITEM_COLUMNS}`,
    [categoryId, name, description ?? null, price, displayOrder ?? 0]
  );
  return rows[0];
}

/**
 * Shop-agnostic - scoped to the whole COMPANY via JOIN menu_categories,
 * since menu_items has no company_id of its own. Optionally filtered to one
 * category.
 */
export async function listActiveItemsForCompany(companyId, categoryId) {
  const params = [companyId];
  let categoryClause = '';
  if (categoryId) {
    params.push(categoryId);
    categoryClause = `AND mi.category_id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.display_order,
            mi.created_at, mi.updated_at
     FROM menu_items mi
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     WHERE mc.company_id = $1 AND mi.deleted_at IS NULL
       ${categoryClause}
     ORDER BY mi.display_order, mi.name`,
    params
  );
  return rows;
}

export async function findActiveItemByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT mi.id, mi.category_id, mi.name, mi.description, mi.price, mi.display_order,
            mi.created_at, mi.updated_at
     FROM menu_items mi
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     WHERE mi.id = $1 AND mc.company_id = $2 AND mi.deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateItem(id, data) {
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
    `UPDATE menu_items SET ${clause} WHERE id = $${values.length} RETURNING ${ITEM_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteItem(id) {
  await query(`UPDATE menu_items SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

// --- Variants (6.3) ---

const VARIANT_COLUMNS = `id, menu_item_id, name, price, display_order, created_at, updated_at`;

export async function createVariant(menuItemId, { name, price, displayOrder }) {
  const { rows } = await query(
    `INSERT INTO menu_item_variants (menu_item_id, name, price, display_order)
     VALUES ($1, $2, $3, $4)
     RETURNING ${VARIANT_COLUMNS}`,
    [menuItemId, name, price, displayOrder ?? 0]
  );
  return rows[0];
}

export async function listActiveVariantsForItem(menuItemId) {
  const { rows } = await query(
    `SELECT ${VARIANT_COLUMNS} FROM menu_item_variants
     WHERE menu_item_id = $1 AND deleted_at IS NULL
     ORDER BY display_order, name`,
    [menuItemId]
  );
  return rows;
}

export async function findActiveVariantByIdForItem(id, menuItemId) {
  const { rows } = await query(
    `SELECT ${VARIANT_COLUMNS} FROM menu_item_variants
     WHERE id = $1 AND menu_item_id = $2 AND deleted_at IS NULL`,
    [id, menuItemId]
  );
  return rows[0] ?? null;
}

/**
 * Company-scoped lookup (via JOIN menu_items -> menu_categories), same
 * pattern as findActiveItemByIdForCompany - used by shopMenu.service.js
 * (6.2/6.3) to confirm a variant belongs to the shop's own company before
 * allowing an override.
 */
export async function findActiveVariantByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT miv.id, miv.menu_item_id, miv.name, miv.price, miv.display_order,
            miv.created_at, miv.updated_at
     FROM menu_item_variants miv
     JOIN menu_items mi ON mi.id = miv.menu_item_id AND mi.deleted_at IS NULL
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     WHERE miv.id = $1 AND mc.company_id = $2 AND miv.deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateVariant(id, data) {
  const fieldMap = { name: 'name', price: 'price', displayOrder: 'display_order' };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE menu_item_variants SET ${clause} WHERE id = $${values.length} RETURNING ${VARIANT_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteVariant(id) {
  await query(`UPDATE menu_item_variants SET deleted_at = now(), updated_at = now() WHERE id = $1`, [
    id,
  ]);
}

// --- Modifiers (6.4) ---

const GROUP_COLUMNS = `id, company_id, name, min_selections, max_selections, created_at, updated_at`;
const OPTION_COLUMNS = `id, modifier_group_id, name, price_delta, display_order, created_at, updated_at`;

export async function createModifierGroup(companyId, { name, minSelections, maxSelections }) {
  const { rows } = await query(
    `INSERT INTO modifier_groups (company_id, name, min_selections, max_selections)
     VALUES ($1, $2, $3, $4)
     RETURNING ${GROUP_COLUMNS}`,
    [companyId, name, minSelections ?? 0, maxSelections ?? 1]
  );
  return rows[0];
}

export async function listActiveModifierGroupsForCompany(companyId) {
  const { rows } = await query(
    `SELECT ${GROUP_COLUMNS} FROM modifier_groups
     WHERE company_id = $1 AND deleted_at IS NULL
     ORDER BY name`,
    [companyId]
  );
  return rows;
}

export async function findActiveModifierGroupByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT ${GROUP_COLUMNS} FROM modifier_groups
     WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateModifierGroup(id, data) {
  const fieldMap = { name: 'name', minSelections: 'min_selections', maxSelections: 'max_selections' };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE modifier_groups SET ${clause} WHERE id = $${values.length} RETURNING ${GROUP_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteModifierGroup(id) {
  await query(`UPDATE modifier_groups SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

/** Used to block deleting a group that still has any (non-deleted) options - same rule as categories. */
export async function countActiveOptionsInGroup(groupId) {
  const { rows } = await query(
    `SELECT count(*)::int AS count FROM modifier_options WHERE modifier_group_id = $1 AND deleted_at IS NULL`,
    [groupId]
  );
  return rows[0].count;
}

export async function createModifierOption(groupId, { name, priceDelta, displayOrder }) {
  const { rows } = await query(
    `INSERT INTO modifier_options (modifier_group_id, name, price_delta, display_order)
     VALUES ($1, $2, $3, $4)
     RETURNING ${OPTION_COLUMNS}`,
    [groupId, name, priceDelta ?? 0, displayOrder ?? 0]
  );
  return rows[0];
}

export async function listActiveOptionsForGroup(groupId) {
  const { rows } = await query(
    `SELECT ${OPTION_COLUMNS} FROM modifier_options
     WHERE modifier_group_id = $1 AND deleted_at IS NULL
     ORDER BY display_order, name`,
    [groupId]
  );
  return rows;
}

export async function findActiveOptionByIdForGroup(id, groupId) {
  const { rows } = await query(
    `SELECT ${OPTION_COLUMNS} FROM modifier_options
     WHERE id = $1 AND modifier_group_id = $2 AND deleted_at IS NULL`,
    [id, groupId]
  );
  return rows[0] ?? null;
}

/**
 * Company-scoped lookup (via JOIN modifier_groups), same pattern as
 * findActiveVariantByIdForCompany - used by shopMenu.service.js to confirm
 * an option belongs to the shop's own company before allowing an override.
 */
export async function findActiveOptionByIdForCompany(id, companyId) {
  const { rows } = await query(
    `SELECT mo.id, mo.modifier_group_id, mo.name, mo.price_delta, mo.display_order,
            mo.created_at, mo.updated_at
     FROM modifier_options mo
     JOIN modifier_groups mg ON mg.id = mo.modifier_group_id AND mg.deleted_at IS NULL
     WHERE mo.id = $1 AND mg.company_id = $2 AND mo.deleted_at IS NULL`,
    [id, companyId]
  );
  return rows[0] ?? null;
}

export async function updateModifierOption(id, data) {
  const fieldMap = { name: 'name', priceDelta: 'price_delta', displayOrder: 'display_order' };
  const { clause, values } = buildUpdateSet(fieldMap, data);
  values.push(id);
  const { rows } = await query(
    `UPDATE modifier_options SET ${clause} WHERE id = $${values.length} RETURNING ${OPTION_COLUMNS}`,
    values
  );
  return rows[0];
}

export async function softDeleteModifierOption(id) {
  await query(`UPDATE modifier_options SET deleted_at = now(), updated_at = now() WHERE id = $1`, [id]);
}

// --- Modifier group <-> MASTER item attachment ---

/** Throws Postgres unique-violation (23505) if this group is already attached to this item. */
export async function attachModifierGroupToItem(menuItemId, modifierGroupId) {
  const { rows } = await query(
    `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
     VALUES ($1, $2)
     RETURNING id, menu_item_id, modifier_group_id, created_at`,
    [menuItemId, modifierGroupId]
  );
  return rows[0];
}

export async function detachModifierGroupFromItem(menuItemId, modifierGroupId) {
  const { rows } = await query(
    `DELETE FROM menu_item_modifier_groups
     WHERE menu_item_id = $1 AND modifier_group_id = $2
     RETURNING id`,
    [menuItemId, modifierGroupId]
  );
  return rows[0] ?? null;
}

/**
 * Modifier groups (with their options) currently attached to ONE master
 * item - unresolved (no shop context, master data only), for the owner's
 * management view. Returns flat rows in the SAME shape as the resolved
 * shop-menu queries in shopMenu.repository.js (item_id/group_id/
 * group_name/min_selections/max_selections/option_id/option_name/
 * master_price_delta/effective_price_delta/is_enabled) so the identical
 * grouping helper in shopMenu.service.js can consume this too - effective
 * price/enabled just equal the master values here, since there's no shop.
 */
export async function listAttachedModifierGroupsForItem(menuItemId) {
  const { rows } = await query(
    `SELECT mi.id AS item_id,
            mg.id AS group_id, mg.name AS group_name,
            mg.min_selections, mg.max_selections,
            mo.id AS option_id, mo.name AS option_name,
            mo.price_delta AS master_price_delta,
            mo.price_delta AS effective_price_delta,
            true AS is_enabled
     FROM menu_item_modifier_groups mimg
     JOIN menu_items mi ON mi.id = mimg.menu_item_id AND mi.id = $1 AND mi.deleted_at IS NULL
     JOIN modifier_groups mg ON mg.id = mimg.modifier_group_id AND mg.deleted_at IS NULL
     JOIN modifier_options mo ON mo.modifier_group_id = mg.id AND mo.deleted_at IS NULL
     ORDER BY mg.name, mo.display_order, mo.name`,
    [menuItemId]
  );
  return rows;
}
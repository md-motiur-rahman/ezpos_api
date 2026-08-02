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
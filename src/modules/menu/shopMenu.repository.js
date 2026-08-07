import { query } from '../../db/pool.js';
import {
  buildUpdateSet,
  attachRelationship,
  detachRelationship,
  attachRelationshipWithQuantity,
  updateRelationshipQuantity,
} from '../../utils/sql.js';

const OVERRIDE_COLUMNS = `id, shop_id, menu_item_id, is_enabled, price_override, created_at, updated_at`;
const LOCAL_ITEM_COLUMNS = `id, shop_id, category_id, name, description, price, display_order, created_at, updated_at`;

// --- Overrides ---

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

// --- Variant overrides (6.3) ---

const VARIANT_OVERRIDE_COLUMNS = `id, shop_id, variant_id, is_enabled, price_override, created_at, updated_at`;

export async function upsertVariantOverride(shopId, variantId, { isEnabled, priceOverride }) {
  const { rows } = await query(
    `INSERT INTO shop_menu_variant_overrides (shop_id, variant_id, is_enabled, price_override)
     VALUES ($1, $2, COALESCE($3, true), $4)
     ON CONFLICT (shop_id, variant_id) DO UPDATE
       SET is_enabled = COALESCE($3, shop_menu_variant_overrides.is_enabled),
           price_override = COALESCE($4, shop_menu_variant_overrides.price_override),
           updated_at = now()
     RETURNING ${VARIANT_OVERRIDE_COLUMNS}`,
    [shopId, variantId, isEnabled ?? null, priceOverride ?? null]
  );
  return rows[0];
}

export async function deleteVariantOverride(shopId, variantId) {
  await query(`DELETE FROM shop_menu_variant_overrides WHERE shop_id = $1 AND variant_id = $2`, [
    shopId,
    variantId,
  ]);
}

export async function listResolvedVariantsForShop(shopId, companyId) {
  const { rows } = await query(
    `SELECT miv.id, miv.menu_item_id, miv.name, miv.display_order,
            miv.price AS master_price,
            COALESCE(smvo.price_override, miv.price) AS effective_price,
            COALESCE(smvo.is_enabled, true) AS is_enabled
     FROM menu_item_variants miv
     JOIN menu_items mi ON mi.id = miv.menu_item_id AND mi.deleted_at IS NULL
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     LEFT JOIN shop_menu_variant_overrides smvo ON smvo.variant_id = miv.id AND smvo.shop_id = $1
     WHERE mc.company_id = $2 AND miv.deleted_at IS NULL
     ORDER BY miv.menu_item_id, miv.display_order, miv.name`,
    [shopId, companyId]
  );
  return rows;
}

// --- Modifier option overrides (6.4) ---

export async function upsertModifierOptionOverride(shopId, optionId, { isEnabled, priceDeltaOverride }) {
  const { rows } = await query(
    `INSERT INTO shop_menu_modifier_option_overrides (shop_id, modifier_option_id, is_enabled, price_delta_override)
     VALUES ($1, $2, COALESCE($3, true), $4)
     ON CONFLICT (shop_id, modifier_option_id) DO UPDATE
       SET is_enabled = COALESCE($3, shop_menu_modifier_option_overrides.is_enabled),
           price_delta_override = COALESCE($4, shop_menu_modifier_option_overrides.price_delta_override),
           updated_at = now()
     RETURNING id, shop_id, modifier_option_id, is_enabled, price_delta_override, created_at, updated_at`,
    [shopId, optionId, isEnabled ?? null, priceDeltaOverride ?? null]
  );
  return rows[0];
}

export async function deleteModifierOptionOverride(shopId, optionId) {
  await query(
    `DELETE FROM shop_menu_modifier_option_overrides WHERE shop_id = $1 AND modifier_option_id = $2`,
    [shopId, optionId]
  );
}

export async function listResolvedModifierGroupsForMasterItems(shopId, companyId) {
  const { rows } = await query(
    `SELECT mi.id AS item_id,
            mg.id AS group_id, mg.name AS group_name,
            mg.min_selections, mg.max_selections,
            mo.id AS option_id, mo.name AS option_name,
            mo.price_delta AS master_price_delta,
            COALESCE(smoo.price_delta_override, mo.price_delta) AS effective_price_delta,
            COALESCE(smoo.is_enabled, true) AS is_enabled
     FROM menu_item_modifier_groups mimg
     JOIN menu_items mi ON mi.id = mimg.menu_item_id AND mi.deleted_at IS NULL
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     JOIN modifier_groups mg ON mg.id = mimg.modifier_group_id AND mg.deleted_at IS NULL
     JOIN modifier_options mo ON mo.modifier_group_id = mg.id AND mo.deleted_at IS NULL
     LEFT JOIN shop_menu_modifier_option_overrides smoo
       ON smoo.modifier_option_id = mo.id AND smoo.shop_id = $1
     WHERE mc.company_id = $2
     ORDER BY mi.id, mg.name, mo.display_order, mo.name`,
    [shopId, companyId]
  );
  return rows;
}

export async function listResolvedModifierGroupsForLocalItems(shopId) {
  const { rows } = await query(
    `SELECT smi.id AS item_id,
            mg.id AS group_id, mg.name AS group_name,
            mg.min_selections, mg.max_selections,
            mo.id AS option_id, mo.name AS option_name,
            mo.price_delta AS master_price_delta,
            COALESCE(smoo.price_delta_override, mo.price_delta) AS effective_price_delta,
            COALESCE(smoo.is_enabled, true) AS is_enabled
     FROM shop_menu_item_modifier_groups smimg
     JOIN shop_menu_items smi ON smi.id = smimg.shop_menu_item_id AND smi.deleted_at IS NULL
     JOIN modifier_groups mg ON mg.id = smimg.modifier_group_id AND mg.deleted_at IS NULL
     JOIN modifier_options mo ON mo.modifier_group_id = mg.id AND mo.deleted_at IS NULL
     LEFT JOIN shop_menu_modifier_option_overrides smoo
       ON smoo.modifier_option_id = mo.id AND smoo.shop_id = smi.shop_id
     WHERE smi.shop_id = $1
     ORDER BY smi.id, mg.name, mo.display_order, mo.name`,
    [shopId]
  );
  return rows;
}

// --- Modifier group <-> LOCAL item attachment ---

export async function attachModifierGroupToLocalItem(shopMenuItemId, modifierGroupId) {
  return attachRelationship(
    'shop_menu_item_modifier_groups',
    'shop_menu_item_id',
    shopMenuItemId,
    'modifier_group_id',
    modifierGroupId
  );
}

export async function detachModifierGroupFromLocalItem(shopMenuItemId, modifierGroupId) {
  return detachRelationship(
    'shop_menu_item_modifier_groups',
    'shop_menu_item_id',
    shopMenuItemId,
    'modifier_group_id',
    modifierGroupId
  );
}

// --- Ingredients / allergens (6.5, extended by 7.2) ---

/** Throws Postgres unique-violation (23505) if this ingredient is already attached to this local item. */
export async function attachIngredientToLocalItem(shopMenuItemId, ingredientId, quantity) {
  return attachRelationshipWithQuantity(
    'shop_menu_item_ingredients',
    'shop_menu_item_id',
    shopMenuItemId,
    'ingredient_id',
    ingredientId,
    quantity
  );
}

/** Adjusts an already-attached ingredient's recipe quantity on a local item, without detaching and reattaching. */
export async function updateLocalItemIngredientQuantity(shopMenuItemId, ingredientId, quantity) {
  return updateRelationshipQuantity(
    'shop_menu_item_ingredients',
    'shop_menu_item_id',
    shopMenuItemId,
    'ingredient_id',
    ingredientId,
    quantity
  );
}

export async function detachIngredientFromLocalItem(shopMenuItemId, ingredientId) {
  return detachRelationship(
    'shop_menu_item_ingredients',
    'shop_menu_item_id',
    shopMenuItemId,
    'ingredient_id',
    ingredientId
  );
}

/** Each row is the ingredient's own fields plus this local item's recipe quantity for it. */
export async function listAttachedIngredientsForLocalItem(shopMenuItemId) {
  const { rows } = await query(
    `SELECT i.id, i.company_id, i.name, i.unit, i.allergens, i.created_at, i.updated_at,
            smii.quantity
     FROM shop_menu_item_ingredients smii
     JOIN ingredients i ON i.id = smii.ingredient_id AND i.deleted_at IS NULL
     WHERE smii.shop_menu_item_id = $1
     ORDER BY i.name`,
    [shopMenuItemId]
  );
  return rows;
}

/**
 * Every master item's aggregated allergen list for the company - each
 * ingredient's `allergens` array is flattened with unnest() and re-unioned
 * with array_agg(DISTINCT ... ORDER BY ...), so Postgres does the
 * union-and-dedupe itself rather than fetching row-per-ingredient and
 * aggregating in JS. Same "derive, don't store" philosophy as
 * isBillingLocked (3.6) - nothing here is persisted, computed fresh every
 * request. An item with zero ingredients (or whose only ingredients have no
 * allergens) simply produces no row - the service layer defaults it to [].
 * Empirically verified this query's union/dedupe behavior directly against
 * Postgres before writing any code around it.
 */
export async function listAggregatedAllergensForMasterItems(companyId) {
  const { rows } = await query(
    `SELECT mi.id AS item_id, array_agg(DISTINCT allergen ORDER BY allergen) AS allergens
     FROM menu_item_ingredients mii
     JOIN menu_items mi ON mi.id = mii.menu_item_id AND mi.deleted_at IS NULL
     JOIN menu_categories mc ON mc.id = mi.category_id AND mc.deleted_at IS NULL
     JOIN ingredients i ON i.id = mii.ingredient_id AND i.deleted_at IS NULL,
          unnest(i.allergens) AS allergen
     WHERE mc.company_id = $1
     GROUP BY mi.id`,
    [companyId]
  );
  return rows;
}

/** Same as above, one level down for LOCAL items - identically-shaped flat rows. */
export async function listAggregatedAllergensForLocalItems(shopId) {
  const { rows } = await query(
    `SELECT smi.id AS item_id, array_agg(DISTINCT allergen ORDER BY allergen) AS allergens
     FROM shop_menu_item_ingredients smii
     JOIN shop_menu_items smi ON smi.id = smii.shop_menu_item_id AND smi.deleted_at IS NULL
     JOIN ingredients i ON i.id = smii.ingredient_id AND i.deleted_at IS NULL,
          unnest(i.allergens) AS allergen
     WHERE smi.shop_id = $1
     GROUP BY smi.id`,
    [shopId]
  );
  return rows;
}
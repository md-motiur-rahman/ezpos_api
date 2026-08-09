import * as menuRepository from '../menu/menu.repository.js';
import * as shopMenuRepository from '../menu/shopMenu.repository.js';
import * as inventoryRepository from './inventory.repository.js';

/**
 * Module 7.9 - the deduction engine.
 *
 * Deliberately has NO HTTP route of its own. Nothing user-facing triggers a
 * deduction: it happens as a consequence of a sale, so the trigger belongs
 * to Module 9 (orders) / 10 (KDS), which will import and call this directly
 * once they exist. Shipping a manual endpoint now would create a way to
 * move real stock with no sale behind it - the exact opposite of what this
 * module is for.
 *
 * This is also why there's no permission check here: an internal service
 * called after a sale has already been authorized has no separate actor to
 * gate. The CALLER is responsible for having authorized the sale.
 */

// Kills IEEE-754 representation noise (0.1 * 3 = 0.30000000000000004)
// before the number reaches Postgres. 6 places is far finer than the 2dp
// quantity_on_hand column stores, so this rounds away only float error,
// never real precision. Applied to the FINAL per-item total, never to
// intermediate values, so nothing accumulates.
const DELTA_PRECISION = 6;

function roundDelta(value) {
  return Number(value.toFixed(DELTA_PRECISION));
}

/**
 * Every ingredient a single sale line consumes, from all three sources,
 * SUMMED - a variant's recipe ADDS to the base item's rather than replacing
 * it (confirmed directly, and deliberately NOT the same shape as 6.3's
 * pricing, where a variant's price is absolute and replaces the item's).
 * So a Large Pizza variant lists only the EXTRA dough over the base recipe,
 * not the total.
 *
 * A line references either a master menu item or a shop-local one, never
 * both - the master/local split from Module 6 reaches all the way down
 * here, since their recipes live in separate tables.
 */
async function collectLineIngredients({
  menuItemId,
  shopMenuItemId,
  variantId,
  modifierOptionIds,
}) {
  const sources = [];

  if (menuItemId) {
    sources.push(menuRepository.listAttachedIngredientsForItem(menuItemId));
  }
  if (shopMenuItemId) {
    sources.push(shopMenuRepository.listAttachedIngredientsForLocalItem(shopMenuItemId));
  }
  if (variantId) {
    sources.push(menuRepository.listAttachedIngredientsForVariant(variantId));
  }
  for (const optionId of modifierOptionIds ?? []) {
    sources.push(menuRepository.listAttachedIngredientsForModifierOption(optionId));
  }

  const results = await Promise.all(sources);
  return results.flat();
}

/**
 * Deducts stock for a completed sale.
 *
 * saleLines: [{ menuItemId | shopMenuItemId, variantId?, modifierOptionIds?, quantity }]
 *
 * Returns { deducted, skipped } rather than throwing on anything short of a
 * real failure - see the two confirmed rules below.
 */
export async function deductInventoryForSale(shopId, saleLines) {
  const lines = saleLines ?? [];
  if (lines.length === 0) {
    return { deducted: [], skipped: [] };
  }

  // --- 1. Sum required quantity per ingredient across the WHOLE sale ---
  // Aggregating across lines (not just within one) matters: two separate
  // lines using the same ingredient must not become two separate stock
  // writes, for the reason spelled out at step 4.
  const required = new Map();

  for (const line of lines) {
    const lineQuantity = Number(line.quantity ?? 0);
    if (lineQuantity <= 0) {
      continue;
    }

    const ingredientRows = await collectLineIngredients(line);

    for (const row of ingredientRows) {
      const existing = required.get(row.id);
      const amount = Number(row.quantity) * lineQuantity;
      if (existing) {
        existing.quantity += amount;
      } else {
        required.set(row.id, { name: row.name, unit: row.unit, quantity: amount });
      }
    }
  }

  if (required.size === 0) {
    return { deducted: [], skipped: [] };
  }

  // --- 2. Resolve each ingredient to this shop's stock item ---
  const ingredientIds = [...required.keys()];
  const linkRows = await inventoryRepository.findIngredientLinksForShop(shopId, ingredientIds);
  const linksByIngredient = new Map(linkRows.map((row) => [row.ingredient_id, row]));

  // --- 3. Convert to inventory units, aggregating by INVENTORY ITEM ---
  const deducted = [];
  const skipped = [];
  const byInventoryItem = new Map();

  for (const [ingredientId, { name, unit, quantity }] of required) {
    const link = linksByIngredient.get(ingredientId);

    if (!link) {
      // Confirmed directly: one unconfigured ingredient must not block the
      // rest of the sale's deductions. Reported so the caller can surface
      // it - silence here would look identical to a correct deduction.
      skipped.push({
        ingredientId,
        name,
        requiredQuantity: roundDelta(quantity),
        unit,
        reason: 'not_linked',
      });
      continue;
    }

    const inventoryQuantity = quantity * Number(link.conversion_factor);
    const runningTotal = byInventoryItem.get(link.inventory_item_id) ?? 0;
    byInventoryItem.set(link.inventory_item_id, runningTotal + inventoryQuantity);

    deducted.push({
      ingredientId,
      name,
      unit,
      requiredQuantity: roundDelta(quantity),
      inventoryItemId: link.inventory_item_id,
      conversionFactor: Number(link.conversion_factor),
      deductedQuantity: roundDelta(inventoryQuantity),
    });
  }

  if (byInventoryItem.size === 0) {
    return { deducted, skipped };
  }

  // --- 4. One atomic write ---
  // Pre-aggregating by inventory item above is REQUIRED for correctness,
  // not a tidiness choice, and this was verified empirically before any of
  // this was written: passing the same id twice to adjustInventoryQuantities'
  // UPDATE...FROM unnest() applies only ONE of the two deltas and silently
  // drops the other (Postgres picks a single arbitrary match when the join
  // matches multiple rows). Two ingredients sharing one stock item - two
  // flours from the same sack, say - would otherwise under-deduct with no
  // error anywhere. Summing in JS first means each id appears exactly once.
  //
  // Aggregating first is also exactly precise: applying 0.125 four times
  // separately lands on 99.52 (each write rounds to the 2dp column), where
  // one -0.5 write lands on 99.50. Verified empirically alongside the above.
  const inventoryItemIds = [...byInventoryItem.keys()];
  // Negated here, at the single point where "how much this sale consumed"
  // becomes "how stock changes" - adjustInventoryQuantities is direction-
  // agnostic (7.6 passes positives for receiving, 7.7 negatives for wastage).
  const amounts = inventoryItemIds.map((id) => roundDelta(-byInventoryItem.get(id)));

  // Confirmed directly: this NEVER blocks on insufficient stock, unlike
  // 7.7's wastage (which 409s rather than go negative). The sale is an
  // already-committed real-world event by the time this runs - refusing to
  // deduct would leave the sale recorded and the stock silently untouched,
  // a worse and harder-to-spot inconsistency than a negative count. A
  // negative quantityOnHand is a visible signal that something needs
  // correcting (via 7.1's PATCH), which is the honest outcome.
  await inventoryRepository.adjustInventoryQuantities(inventoryItemIds, amounts);

  return { deducted, skipped };
}

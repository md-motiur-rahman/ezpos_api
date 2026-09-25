import { requireViewInventory, requireManageInventory } from './inventory.service.js';
import * as inventoryRepository from './inventory.repository.js';
import * as receiptAliasRepository from './receiptAlias.repository.js';

/**
 * "Chk." and "chk" are the same wording. The scan screen normalises the same
 * way before looking anything up, so both sides agree on the key.
 */
export function normalizeWording(text) {
  // NFC first so composed and decomposed "café" agree. \p{M} is kept because
  // combining marks carry meaning in many scripts (e.g. Bengali vowel signs).
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

export async function listAliases(actor, shopId) {
  await requireViewInventory(actor, shopId);
  const rows = await receiptAliasRepository.listForShop(shopId);
  return rows.map((row) => ({ wording: row.wording, inventoryItemId: row.inventory_item_id }));
}

/**
 * Best effort by design: remembering a wording must never fail a stock
 * receipt, so an item that is gone or belongs to another shop is skipped
 * rather than rejected, and a wording that normalises to nothing is ignored.
 * If the same wording appears twice, the later VALID one wins — eligibility is
 * checked before the "later wins" rule, so an invalid later entry can't
 * discard an earlier valid one.
 */
export async function saveAliases(actor, shopId, aliases) {
  await requireManageInventory(actor, shopId);

  const activeCache = new Map();
  const isActive = async (itemId) => {
    if (!activeCache.has(itemId)) {
      activeCache.set(
        itemId,
        Boolean(await inventoryRepository.findActiveItemByIdForShop(itemId, shopId))
      );
    }
    return activeCache.get(itemId);
  };

  const byWording = new Map();
  for (const { wording, inventoryItemId } of aliases) {
    const key = normalizeWording(wording);
    if (key && (await isActive(inventoryItemId))) byWording.set(key, inventoryItemId);
  }

  const wordings = [...byWording.keys()];
  const itemIds = [...byWording.values()];

  if (wordings.length > 0) {
    await receiptAliasRepository.upsertMany(shopId, wordings, itemIds);
  }
  return { saved: wordings.length };
}

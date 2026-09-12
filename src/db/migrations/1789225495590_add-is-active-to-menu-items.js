export const shorthands = undefined;

/**
 * Master menu items had no way to be taken off the menu company-wide short of
 * deleting them - categories already got exactly this in their original
 * migration (is_active, distinct from deleted_at: gone-from-management vs.
 * still-manageable-but-not-live), items were simply missed.
 *
 * Mirrors that column exactly, including NOT filtering on it anywhere -
 * categories' own is_active is purely informational today (not applied in
 * listActiveCategoriesForCompany, not read by shopMenu's resolved menu), and
 * this does the same for items so the two stay consistent. `DEFAULT true`
 * means every pre-existing item reads back active with no backfill needed.
 */
export const up = (pgm) => {
  pgm.addColumn('menu_items', {
    is_active: { type: 'boolean', notNull: true, default: true },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('menu_items', 'is_active');
};

/**
 * The UK's 14 official allergens (FSA "Food Information for Consumers"
 * regulation). A small, fixed, rarely-changing set - a code constant here,
 * not a database table, same precedent as ROLES/PERMISSIONS in 4.1. A DB
 * table would risk silent duplicates ("Dairy" vs "dairy") for no benefit.
 */
export const ALLERGENS = Object.freeze([
  'celery',
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'lupin',
  'milk',
  'molluscs',
  'mustard',
  'tree_nuts',
  'peanuts',
  'sesame',
  'soybeans',
  'sulphites',
]);
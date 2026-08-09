import { z } from 'zod';

// Shared by create (optional) and update (nullable + optional) below -
// whole days, strictly positive: 0 isn't a meaningful shelf life, and
// "not tracked" is already expressed by leaving the field out/null rather
// than by a zero value.
const shelfLifeDaysSchema = z
  .number()
  .int('shelf life must be a whole number of days')
  .positive('shelf life must be greater than 0 days');

// Not every item is barcode-tracked, so this is always optional/nullable,
// never required - same shape as the shelf-life fields below (8.2).
const skuSchema = z.string().trim().min(1, 'sku cannot be empty');

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required'),
  unit: z.string().trim().min(1, 'Unit is required'),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
  lowStockThreshold: z.number().min(0, 'lowStockThreshold cannot be negative').optional(),
  shelfLifeDays: shelfLifeDaysSchema.optional(),
  shelfLifeOpenedDays: shelfLifeDaysSchema.optional(),
  sku: skuSchema.optional(),
});

export const updateInventoryItemSchema = z.object({
  name: z.string().trim().min(1, 'Item name is required').optional(),
  unit: z.string().trim().min(1, 'Unit is required').optional(),
  quantityOnHand: z.number().min(0, 'quantityOnHand cannot be negative').optional(),
  // Nullable AND optional, deliberately different from the other fields:
  // omitting this key leaves the threshold untouched, but explicitly
  // sending `null` clears it back to "not tracked for alerting" - the same
  // "explicit null clears, omitted leaves alone" contract buildUpdateSet
  // already relies on everywhere else in this project.
  lowStockThreshold: z.number().min(0, 'lowStockThreshold cannot be negative').nullable().optional(),
  // Same nullable-and-optional contract as lowStockThreshold above (8.1).
  shelfLifeDays: shelfLifeDaysSchema.nullable().optional(),
  shelfLifeOpenedDays: shelfLifeDaysSchema.nullable().optional(),
  // Same contract again (8.2) - explicit null un-tracks the barcode.
  sku: skuSchema.nullable().optional(),
});

export const inventoryItemIdParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid inventory item id'),
});

// Query params always arrive as strings - explicit 'true'/'false' enum
// rather than z.coerce.boolean(), which would incorrectly treat the
// literal string "false" as truthy (Boolean("false") === true in JS).
export const inventoryListQuerySchema = z.object({
  lowStockOnly: z.enum(['true', 'false']).optional(),
});

// --- Item <-> supplier linking (7.4) ---

export const itemSupplierParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid inventory item id'),
  supplierId: z.string().uuid('Invalid supplier id'),
});

// isDefault optional on attach - a supplier can be linked without being
// made the default immediately.
export const attachSupplierBodySchema = z.object({
  isDefault: z.boolean().optional(),
});

// Required on PATCH, unlike attach - this endpoint exists specifically to
// let the default be changed later ("chicken breast defaults to Bidfood but
// can also come from another vendor"), so the one field it edits isn't
// optional.
export const updateItemSupplierBodySchema = z.object({
  isDefault: z.boolean(),
});

// --- Ingredient <-> inventory item linking (7.9) ---

export const itemIngredientParamSchema = z.object({
  shopId: z.string().uuid('Invalid shop id'),
  itemId: z.string().uuid('Invalid inventory item id'),
  ingredientId: z.string().uuid('Invalid ingredient id'),
});

// Strictly positive, not just non-negative: a factor of 0 would mean a
// recipe ingredient consumes no stock at all, which is what NOT linking it
// already expresses - and it would silently produce zero-deduction rows
// that look like successful deductions in the engine's return value.
const conversionFactorSchema = z
  .number()
  .positive('conversionFactor must be greater than zero');

// Optional on link - defaults to 1 (the "recipe unit and stock unit are the
// same thing" case, which is the common one).
export const linkIngredientBodySchema = z.object({
  conversionFactor: conversionFactorSchema.optional(),
});

// Required on PATCH - same reasoning as updateItemSupplierBodySchema above:
// this endpoint exists solely to change that one value.
export const updateIngredientLinkBodySchema = z.object({
  conversionFactor: conversionFactorSchema,
});
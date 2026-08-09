export const shorthands = undefined;

export const up = (pgm) => {
  // Per-shop, matching every other till-adjacent table in this project.
  // No deleted_at - a future 'cancelled' status (9.4, not built yet) is the
  // soft-delete-equivalent, not a row deletion, same "no reversal
  // mechanism, correct via a new action" philosophy already established
  // for wastage/receipts.
  pgm.createTable('orders', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    // Validated at the app layer against a small fixed ORDER_TYPES list -
    // same code-constant precedent as WASTAGE_REASONS/SCAN_STATES, not a
    // DB enum type.
    type: { type: 'text', notNull: true },
    // Free text, not a Table entity - no table-management concept exists
    // anywhere in this system (confirmed directly). Required (at the app
    // layer) when type is 'dine_in', absent for 'takeaway'.
    table_number: { type: 'text' },
    // Always optional, for either order type - no customer entity exists
    // yet (that's Module 11, phone-number based, not built).
    customer_name: { type: 'text' },
    // Deliberately MINIMAL for now (confirmed directly) - only 'open' is a
    // valid value today. 9.4 (cancellation) and 9.5 (payment) will extend
    // this JS-constant list with their own values when they're actually
    // designed, rather than 9.1 guessing at a lifecycle those submodules
    // haven't been scoped yet to need.
    status: { type: 'text', notNull: true, default: 'open' },
    // Who rang this order in - follows the req.actor pattern already used
    // at the request layer (type: 'owner'|'staff', plus the acting id).
    // Useful for accountability/reporting (12.x) even though nothing reads
    // it yet.
    created_by_actor_type: { type: 'text', notNull: true },
    created_by_actor_id: { type: 'uuid', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One line per menu item/local item ordered. Exactly one of menu_item_id/
  // shop_menu_item_id is set - enforced at the app layer (zod .refine()),
  // matching this project's convention of validating cross-field rules
  // there rather than a DB CHECK constraint. unit_price is a SNAPSHOT of
  // the item/variant's resolved price at order time (via shopMenu's
  // getResolvedMenu, already built for exactly this in Module 6) - this is
  // charged/historical data, not a live-derivable value, so "derive don't
  // store" does NOT apply here the way it does to isLowStock etc. No
  // updated_at - immutable line once created, same as wastage_log_items/
  // purchase_order_receipt_items.
  pgm.createTable('order_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    order_id: { type: 'uuid', notNull: true, references: 'orders' },
    menu_item_id: { type: 'uuid', references: 'menu_items' },
    shop_menu_item_id: { type: 'uuid', references: 'shop_menu_items' },
    // Variants are a master-item-only concept (6.3's established
    // precedent) - only ever set alongside menu_item_id, never
    // shop_menu_item_id. Not enforced at the DB level, same app-layer
    // convention as above.
    variant_id: { type: 'uuid', references: 'menu_item_variants' },
    quantity: { type: 'integer', notNull: true },
    unit_price: { type: 'numeric(10,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Selected modifier options for one order line, each with its OWN
  // snapshotted price_delta - kept as separate itemized rows rather than
  // pre-summed into order_items.unit_price, so a receipt can show
  // "Burger £8.00 + Extra Cheese £1.00" rather than a blended total, and
  // 12.x reporting can attribute modifier revenue separately later.
  pgm.createTable('order_item_modifiers', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    order_item_id: { type: 'uuid', notNull: true, references: 'order_items' },
    modifier_option_id: { type: 'uuid', notNull: true, references: 'modifier_options' },
    price_delta: { type: 'numeric(10,2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('orders', 'shop_id');
  pgm.createIndex('order_items', 'order_id');
  pgm.createIndex('order_item_modifiers', 'order_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('order_item_modifiers');
  pgm.dropTable('order_items');
  pgm.dropTable('orders');
};

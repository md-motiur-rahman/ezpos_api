export const shorthands = undefined;

export const up = (pgm) => {
  // A single receiving EVENT against a PO. Multiple receipts per PO are
  // confirmed in scope (a big order can arrive in separate deliveries).
  // Deliberately NO deleted_at - immutable once created, since it
  // represents an already-applied stock change (inventory_items.
  // quantity_on_hand is incremented when a receipt is logged). Correcting
  // a mistaken receipt goes through 7.1's existing manual quantityOnHand
  // correction, not a reversal mechanism here.
  pgm.createTable('purchase_order_receipts', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    purchase_order_id: { type: 'uuid', notNull: true, references: 'purchase_orders' },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // References the ORIGINAL PO line item (not inventory_item_id directly) -
  // this is what lets received-so-far be summed per PO line item and
  // compared against what was ordered, and naturally prevents receiving
  // something that wasn't part of this PO in the first place.
  pgm.createTable('purchase_order_receipt_items', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    purchase_order_receipt_id: { type: 'uuid', notNull: true, references: 'purchase_order_receipts' },
    purchase_order_item_id: { type: 'uuid', notNull: true, references: 'purchase_order_items' },
    quantity_received: { type: 'numeric(10,3)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('purchase_order_receipts', 'purchase_order_id');
  pgm.createIndex('purchase_order_receipt_items', 'purchase_order_receipt_id');
  pgm.createIndex('purchase_order_receipt_items', 'purchase_order_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('purchase_order_receipt_items');
  pgm.dropTable('purchase_order_receipts');
};
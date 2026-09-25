export const shorthands = undefined;

export const up = (pgm) => {
  // What a supplier's receipt calls a stock item ("chk", "chicken brst 10kg")
  // -> the shop's own item, remembered from the last time someone corrected
  // it on the scan review screen. Per shop, like inventory_items: two shops
  // can read the same wording differently.
  //
  // `wording` is stored already normalised (lowercase, punctuation stripped,
  // whitespace collapsed - see receiptAlias.service.js) so lookups are a
  // plain equality match and "Chk." and "chk" are one row.
  pgm.createTable('receipt_aliases', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops' },
    wording: { type: 'text', notNull: true },
    inventory_item_id: { type: 'uuid', notNull: true, references: 'inventory_items' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One meaning per wording per shop; correcting it again overwrites.
  pgm.addConstraint('receipt_aliases', 'receipt_aliases_unique_wording', {
    unique: ['shop_id', 'wording'],
  });
  pgm.createIndex('receipt_aliases', 'inventory_item_id');
};

export const down = (pgm) => {
  pgm.dropTable('receipt_aliases');
};

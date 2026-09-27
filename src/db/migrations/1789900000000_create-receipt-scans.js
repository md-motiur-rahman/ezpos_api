export const shorthands = undefined;

// Every attempt to read a receipt with the cloud AI reader (10.5), one row
// each — the count this app's own per-shop scan limit is checked against
// (receiptScan.service.js), and the raw material for a real cost figure
// later instead of guessing at it. Kept even for a failed/blocked attempt,
// since a shop hitting nothing but errors is exactly the case worth being
// able to see.
export const up = (pgm) => {
  pgm.createTable('receipt_scans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    shop_id: { type: 'uuid', notNull: true, references: 'shops', onDelete: 'CASCADE' },
    // Polymorphic, same 'owner' | 'staff' + id pair as
    // staff_permission_overrides.granted_by_type/granted_by_id — whichever
    // actor ran this scan.
    requested_by_type: { type: 'text', notNull: true },
    requested_by_id: { type: 'uuid', notNull: true },
    provider: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true }, // 'pending' | 'ok' | 'error' | 'blocked'
    // Whether this attempt could have cost money — true for a real answer,
    // a blocked/refused answer, or a timeout after the request went out;
    // false for anything that never left this server (no API key
    // configured, a network failure before Google ever saw it) and for the
    // 'pending' row a scan starts as. The limit check counts THIS, not
    // status = 'ok', so a shop that keeps hitting billed failures still
    // gets stopped instead of quietly running up an unbounded bill.
    billable: { type: 'boolean', notNull: true, default: false },
    error_message: { type: 'text' },
    prompt_tokens: { type: 'integer' },
    output_tokens: { type: 'integer' },
    // Whole hundredths of a penny (1/10,000 GBP) — fine enough for a
    // fraction-of-a-penny call without floating point. NULL when the call
    // never reached the provider, timed out with no usage figure to read,
    // or its pricing isn't known.
    estimated_cost_hundredth_pence: { type: 'integer' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('receipt_scans', 'shop_id');
  // The limit check counts today's/this month's billable rows for one shop
  // — exactly this shape.
  pgm.createIndex('receipt_scans', ['shop_id', 'billable', 'created_at']);
};

export const down = (pgm) => {
  pgm.dropTable('receipt_scans');
};

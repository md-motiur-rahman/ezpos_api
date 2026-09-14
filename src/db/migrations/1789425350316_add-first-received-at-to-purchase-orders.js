export const shorthands = undefined;

/**
 * Makes deleting a PO and receiving against it MUTUALLY EXCLUSIVE.
 *
 * A PO must not be deletable once stock has been received against it, but
 * checking that with `NOT EXISTS (SELECT ... FROM purchase_order_receipts)`
 * inside the DELETE does not hold under concurrency, and this was verified
 * empirically rather than assumed: with two overlapping transactions, the
 * delete correctly BLOCKS on the PO's row lock, but when it unblocks,
 * READ COMMITTED re-checks the qual against the updated ROW while the
 * subquery on the other table still uses the original snapshot. The
 * just-committed receipt is therefore invisible and the delete succeeds
 * anyway - leaving a deleted PO with a live receipt and unexplained stock.
 * (10.3's deduction claim looks similar but is safe for the opposite reason:
 * its condition is a column on the same row, which IS re-read.)
 *
 * So the condition moves onto the PO row itself. Receiving stamps
 * first_received_at on the PO in the same statement that inserts the receipt;
 * deletion requires it to still be NULL. Both now touch one row, so Postgres
 * serialises them and the loser's re-check sees the winner's write - verified
 * empirically in both orderings before this was relied on.
 *
 * It is deliberately a timestamp rather than a boolean flag: it answers "when
 * did goods first arrive against this order", which is real information, and
 * COALESCE keeps the FIRST value so later partial deliveries never overwrite
 * it. The alternative - a redundant has_receipts boolean - would carry the
 * same drift risk with none of the meaning.
 *
 * The backfill is load-bearing, not cosmetic: without it every PO that has
 * ALREADY been received against would read NULL and become deletable, which
 * is precisely the bug this prevents.
 */
export const up = (pgm) => {
  pgm.addColumn('purchase_orders', {
    first_received_at: { type: 'timestamptz' },
  });

  pgm.sql(`
    UPDATE purchase_orders po
    SET first_received_at = r.first_received_at
    FROM (
      SELECT purchase_order_id, min(received_at) AS first_received_at
      FROM purchase_order_receipts
      GROUP BY purchase_order_id
    ) r
    WHERE r.purchase_order_id = po.id
  `);
};

export const down = (pgm) => {
  pgm.dropColumn('purchase_orders', 'first_received_at');
};

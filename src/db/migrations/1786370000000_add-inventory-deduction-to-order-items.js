export const shorthands = undefined;

export const up = (pgm) => {
  // 10.3 - the per-item inventory deduction trigger.
  //
  // NULLABLE with no default, deliberately UNLIKE 10.2's `status` (which is
  // NOT NULL DEFAULT 'pending'). The nullability IS the regression strategy,
  // the same reasoning as 9.7's client_order_id and 9.8's vat_rate: every
  // pre-existing order_item, and every item created through 9.1/9.2/9.7,
  // reads back as NULL - "no deduction has ever been made for this line" -
  // so nothing about Modules 7/9's existing behaviour changes by
  // construction rather than by remembering to re-test it.
  //
  // This column is the IDEMPOTENCY MARKER, and that is its whole purpose.
  // 10.2 deliberately made item status transitions UNRESTRICTED, so an item
  // can legitimately re-enter 'ready' any number of times (a mis-tap
  // corrected back to 'in_progress' and then set to 'ready' again is normal
  // kitchen behaviour). Stock, however, may only ever move ONCE per line.
  // The claim is made atomically in a single statement -
  //   UPDATE ... SET inventory_deducted_at = now()
  //   WHERE id = $1 AND inventory_deducted_at IS NULL RETURNING id
  // - so exactly one caller can ever win it, even with two KDS screens in
  // the same shop tapping 'ready' simultaneously (10.1 explicitly supports
  // and tests multiple screens per shop). Verified empirically against the
  // real database before any code was written around it: under two genuinely
  // concurrent transactions exactly one returns a row and the other returns
  // zero, and a repeated sequential call returns zero.
  //
  // A timestamptz rather than a boolean: it costs the same, and "when did
  // this line move stock" is a real audit question that a bare flag cannot
  // answer. Same shape as every other event marker on this table
  // (discounted_at, voided_at, status_updated_at).
  //
  // Deliberately NOT exposed in the API response - this route is VIEW_KDS-
  // gated and inventory data belongs to VIEW_INVENTORY, the same separation
  // 8.2 made when it kept quantityOnHand out of the scan response.
  pgm.addColumns('order_items', {
    inventory_deducted_at: { type: 'timestamptz' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('order_items', ['inventory_deducted_at']);
};

export const shorthands = undefined;

export const up = (pgm) => {
  // 9.8 - VAT calculation. NULLABLE, no default, deliberately: a sale's VAT
  // rate is a historical/compliance fact about THAT sale, same reasoning
  // that made order_items.unit_price a SNAPSHOT rather than something
  // re-derived from the current menu (9.1). If the shop's vat_registered
  // flag or default_vat_rate changed after an order was placed, re-deriving
  // VAT live from today's settings would silently misstate what was
  // actually charged and reported at the time of sale.
  //
  // Every pre-9.8 order (and any order that predates this migration) has
  // this as NULL, meaning "VAT was never calculated for this historical
  // order" - an honest signal, not a fabricated 0%. Every order created
  // FROM NOW ON always gets an explicit value written (0 for a
  // non-VAT-registered shop, or the shop's configured rate) - see
  // order.service.js's resolveVatRate, called once at creation time
  // (createOrder) and at sync time (9.7's syncOfflineOrder), never touched
  // by any later mutation (add-items, discounts, cancel/void, payments,
  // refunds).
  //
  // numeric(5,2), matching shops.default_vat_rate exactly (see
  // 1784995319471_add-settings-to-shops.js) - the value copied in here is
  // already at that same precision, so no new rounding behavior is
  // introduced by this column.
  pgm.addColumns('orders', {
    vat_rate: { type: 'numeric(5,2)' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('orders', ['vat_rate']);
};

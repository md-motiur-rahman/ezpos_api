export const shorthands = undefined;

export const up = (pgm) => {
  pgm.addColumns('shops', {
    kds_enabled: { type: 'boolean', notNull: true, default: false },
    rota_enabled: { type: 'boolean', notNull: true, default: false },
    // No default, deliberately - must be stated explicitly at creation
    // (same reasoning as companies.business_type). Added nullable here,
    // backfilled below, then constrained NOT NULL - required because this
    // table may already have rows (unlike business_type, which was added
    // to a column with no NOT NULL requirement).
    vat_registered: { type: 'boolean' },
    default_vat_rate: { type: 'numeric(5,2)' },
  });

  pgm.sql(`UPDATE shops SET vat_registered = false WHERE vat_registered IS NULL`);
  pgm.alterColumn('shops', 'vat_registered', { notNull: true });
};

export const down = (pgm) => {
  pgm.dropColumns('shops', ['kds_enabled', 'rota_enabled', 'vat_registered', 'default_vat_rate']);
};
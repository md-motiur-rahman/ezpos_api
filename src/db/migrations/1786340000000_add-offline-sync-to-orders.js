export const shorthands = undefined;

export const up = (pgm) => {
  // 9.7 - offline sync. All three columns are NULLABLE with no default, so
  // every pre-existing order and every order created through the normal
  // online flow (9.1's POST /orders) keeps exactly today's shape and
  // behaviour: these are null for anything that didn't arrive through the
  // sync endpoint. That is the whole regression strategy - 9.1-9.6 are
  // unaffected by construction rather than by remembering to re-test.
  pgm.addColumns('orders', {
    // The till's OWN id for the transaction, generated on the device at the
    // moment of the offline sale - before any network exists to hand out a
    // server id. This is the idempotency key: the same queued sale replayed
    // any number of times must produce exactly one order.
    //
    // `text`, not `uuid`: it's the client's identifier, and constraining its
    // format would be us dictating how a device names its own queue entries.
    // Same reasoning as stripe_webhook_events.stripe_event_id (Module 3),
    // which is the closest existing precedent in this project for a
    // dedup key supplied by someone else.
    client_order_id: { type: 'text' },
    // When the sale actually happened ON THE DEVICE, which for a queued
    // order is necessarily EARLIER than created_at (when the server finally
    // processed it). Exactly the same split stripe_webhook_events draws
    // between occurred_at (Stripe's own timestamp for the event) and
    // created_at (when we processed it).
    //
    // timestamptz, not date - this is a real instant, so the 8.2 `date`
    // local-midnight trap (CLAUDE.md section 2) does not apply here and
    // .toISOString() is the CORRECT way to render it back out.
    occurred_at: { type: 'timestamptz' },
    // SHA-256 of the canonicalized sync payload. This is what makes a
    // replay distinguishable from a KEY COLLISION: a retry carrying the
    // identical payload is a genuine idempotent replay and returns the
    // original order, while the same client_order_id arriving with a
    // DIFFERENT payload is a real client bug (a reused key) and is rejected
    // 409 rather than silently returning someone else's order.
    sync_payload_hash: { type: 'text' },
  });

  // THE dedup mechanism - the unique index does the work, exactly as
  // stripe_webhook_events.stripe_event_id's unique constraint does for
  // Stripe's retried deliveries. The app layer just reads whether a row
  // came back.
  //
  // PARTIAL (WHERE client_order_id IS NOT NULL), same shape as 8.2's
  // inventory_items_one_sku_per_shop and 7.4's one-default-per-item index:
  // every normally-created order has NO client_order_id, and those must
  // never collide with each other. Verified empirically before any code was
  // written around it - three NULL-key rows in the same shop all inserted
  // cleanly.
  //
  // Scoped per SHOP, not globally or per company - deliberately, and for
  // the same reason 8.2's SKU index is per-shop: two different shops' tills
  // generate their ids independently and could legitimately produce the
  // same string, and a wider constraint would make one shop's sale block
  // the other's forever.
  //
  // EMPIRICALLY VERIFIED (and a real trap): an ON CONFLICT clause targeting
  // this index MUST restate the predicate -
  //   ON CONFLICT (shop_id, client_order_id) WHERE client_order_id IS NOT NULL
  // Omitting the WHERE does NOT fall back to a plain unique check; Postgres
  // raises 42P10 "there is no unique or exclusion constraint matching the
  // ON CONFLICT specification" and the insert fails outright. Confirmed
  // against the real database before the repository code was written.
  pgm.createIndex('orders', ['shop_id', 'client_order_id'], {
    unique: true,
    where: 'client_order_id IS NOT NULL',
    name: 'orders_one_client_order_id_per_shop',
  });
};

export const down = (pgm) => {
  pgm.dropIndex('orders', ['shop_id', 'client_order_id'], {
    name: 'orders_one_client_order_id_per_shop',
  });
  pgm.dropColumns('orders', ['client_order_id', 'occurred_at', 'sync_payload_hash']);
};

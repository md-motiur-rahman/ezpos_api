import { query } from '../../db/pool.js';

/**
 * Records a processed event. Returns the new row, or null if this event id was
 * already recorded (Stripe retries deliveries, so duplicates are expected and
 * are not an error). ON CONFLICT DO NOTHING makes the unique constraint on
 * stripe_event_id do the deduplication work for us.
 */
export async function recordEvent({
  stripeEventId,
  eventType,
  companyId,
  amount,
  status,
  occurredAt,
}) {
  const { rows } = await query(
    `INSERT INTO stripe_webhook_events
       (stripe_event_id, event_type, company_id, amount, status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [stripeEventId, eventType, companyId, amount, status, occurredAt]
  );
  return rows[0] ?? null;
}
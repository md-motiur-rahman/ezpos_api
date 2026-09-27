import { pool, query } from '../../db/pool.js';

const PROVIDER = 'gemini';

// A 'pending' row only counts toward the limit for this long. Gemini calls
// are bounded to 25s (geminiReceiptClient.js's own REQUEST_TIMEOUT_MS), so
// a genuine in-flight request is never 'pending' for anywhere near this -
// the margin is there for a process that dies mid-call (finalizeScan never
// runs) or a caller that throws something other than an AppError (the one
// case receiptScan.service.js's own catch block doesn't finalize either).
// Past this window a stuck row can only be one of those, never a real
// request still running, so it stops holding a slot.
const PENDING_STALE_AFTER = "5 minutes";

/**
 * Reserves this shop's next scan slot and checks it against the daily/
 * monthly limit in the same breath, so two requests arriving together can't
 * both read "under the limit" and both go on to call Gemini.
 *
 * `pg_advisory_xact_lock` serializes callers for the same shop — the second
 * one blocks here until the first's transaction ends, then re-counts against
 * whatever the first one just committed, so the count and the reservation
 * can never interleave. This is the one place in the app that reaches for a
 * real transaction rather than a single atomic statement: an advisory lock
 * only means anything held across more than one statement, and unlike a
 * bulk unnest() write there's no way to fold "count, then conditionally
 * insert" into one.
 *
 * Returns `{ ok: true, scanId }` for a caller clear to proceed — a 'pending'
 * row already sits in the table, to be filled in by `finalizeScan` once the
 * Gemini call actually finishes — or `{ ok: false, reason }` when the shop
 * is already at its limit, with nothing written.
 */
export async function reserveScanSlot(shopId, actor, { dailyLimit, monthlyLimit, model }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [shopId]);

    // Counts `billable` rows AND still-'pending' ones no older than
    // PENDING_STALE_AFTER. A fresh 'pending' row is this SAME reservation
    // logic's own in-flight attempt (this call, or a sibling call for this
    // shop that got the lock a moment earlier and is out at Gemini right
    // now) - it hasn't resolved to billable yet, but it might, so it has to
    // hold its place in the count; without this half, a batch of concurrent
    // requests would each see zero billable rows (none of them have
    // finished yet) and all sail under the limit, the exact race this
    // function exists to close, just moved one step earlier. The age cutoff
    // is the other half: without it, a row that gets stuck in 'pending'
    // (see PENDING_STALE_AFTER's own comment) would hold its slot for the
    // rest of the calendar day/month, compounding with every other stuck
    // row until the shop's real limit quietly becomes however many crashes
    // happened to land, rather than the number configured.
    const { rows } = await client.query(
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today,
         count(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS this_month
       FROM receipt_scans
       WHERE shop_id = $1
         AND (billable OR (status = 'pending' AND created_at > now() - interval '${PENDING_STALE_AFTER}'))`,
      [shopId]
    );
    const usage = { today: rows[0].today, thisMonth: rows[0].this_month };

    if (usage.today >= dailyLimit) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'daily', usage };
    }
    if (usage.thisMonth >= monthlyLimit) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'monthly', usage };
    }

    const inserted = await client.query(
      `INSERT INTO receipt_scans
         (shop_id, requested_by_type, requested_by_id, provider, model, status, billable)
       VALUES ($1, $2, $3, $4, $5, 'pending', false)
       RETURNING id`,
      [shopId, actor.type, actor.id, PROVIDER, model]
    );
    await client.query('COMMIT');
    return { ok: true, scanId: inserted.rows[0].id };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fills in the 'pending' row `reserveScanSlot` created, once the Gemini call
 * (or the attempt to make one) has actually finished. A plain UPDATE, not
 * inside the reservation's own transaction — the advisory lock only needs
 * to guard the count-and-reserve step, and holding it for however long the
 * external call takes would serialize every scan in a shop behind one
 * in-flight request instead of just the accounting.
 *
 * KNOWN LIMITATION: if the process dies between reserve and finalize (or
 * throws something that isn't an AppError, which `receiptScan.service.js`'s
 * own catch block doesn't finalize either), the row stays 'pending'
 * forever. `reserveScanSlot` only holds that against the shop's limit for
 * PENDING_STALE_AFTER, not indefinitely — rare (the window is one outbound
 * HTTP call), self-healing, and the safer direction to be wrong in for
 * that window: the alternative, never counting a pending row at all, would
 * let concurrent requests double up during that same window instead of
 * just costing the shop one slot until it ages out.
 */
export async function finalizeScan(scanId, entry) {
  await query(
    `UPDATE receipt_scans
     SET status = $2, billable = $3, model = $4, error_message = $5,
         prompt_tokens = $6, output_tokens = $7, estimated_cost_hundredth_pence = $8
     WHERE id = $1`,
    [
      scanId,
      entry.status,
      entry.billable,
      entry.model,
      entry.errorMessage ?? null,
      entry.promptTokens ?? null,
      entry.outputTokens ?? null,
      entry.estimatedCostHundredthPence ?? null,
    ]
  );
}

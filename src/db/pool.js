import pg from 'pg';
import config from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * Single shared connection pool for the whole app.
 * Every module's repository layer will import { query } from here rather
 * than creating its own connections - this keeps connection count under
 * control under real POS load (many tills hitting the API concurrently).
 */
export const pool = new Pool({
  connectionString: config.env.databaseUrl,

  // `pg` defaults connectionTimeoutMillis to 0, which means "wait FOREVER for
  // a free connection". That is why an exhausted pool has shown up in this
  // project as a test file that hangs indefinitely rather than as an error -
  // see the 10.1 and 10.2 notes in CLAUDE.md, where a run appeared to stall
  // for 20+ minutes and was recorded as environment noise. A request that
  // cannot get a connection within 10s is a real problem (saturation or a
  // leak), and it should say so loudly instead of hanging until something
  // else times out. Healthy queries here acquire in single-digit
  // milliseconds, so this can only fire on genuine starvation.
  connectionTimeoutMillis: 10_000,

  // Server-side ceiling on any single statement. Without it, one pathological
  // query holds its connection for as long as it takes and, with a small
  // pool, can starve every other request behind it. Every query in this
  // codebase is small indexed CRUD, so 30s is far above anything legitimate.
  // Migrations are unaffected: node-pg-migrate opens its own connection and
  // does not go through this pool.
  statement_timeout: 30_000,

  // max is deliberately left at pg's default of 10. Production runs a SINGLE
  // Render web service (render.yaml, plan: starter), so one process owns one
  // pool of 10 - comfortably inside any Postgres tier's limit. The place 10
  // actually bites is the TEST suite, where `node --test` runs ~8 files in
  // parallel, each its own process with its own pool of 10, against a
  // max_connections of 100. That is a test-harness concern, not a production
  // one, and tightening it here would not be the right lever.
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

/**
 * Run a query against the pool. Thin wrapper for now; later modules
 * (transactions, etc.) will add helpers alongside this one.
 */
export function query(text, params) {
  return pool.query(text, params);
}

/**
 * Used at boot (and by /health) to confirm the database is actually reachable.
 */
export async function checkDbConnection() {
  await pool.query('SELECT 1');
}

/**
 * The transaction helper this file's own `query` doc anticipated ("later
 * modules... will add helpers alongside this one") - added for 9.5's
 * payment race (a concurrent request reading the same balance before either
 * insert commits, confirmed reachable and previously an accepted "narrow
 * window, single-till reality" limitation like every other money/stock
 * write in this project). Checks out ONE dedicated client, runs
 * `callback(client)` between BEGIN/COMMIT, and ROLLBACKs on any thrown
 * error before re-throwing it unchanged - the caller's own error handling
 * (AppError, 402s, etc.) is untouched by this wrapper.
 *
 * Deliberately narrow, not a general-purpose "use transactions everywhere"
 * shift: every other write in this project still goes through the plain
 * `query()` pool wrapper and stays exactly as atomic (or not) as it already
 * documented itself to be. `callback` receives the checked-out `client` and
 * MUST use it (not `query()`/the pool) for every statement that needs to
 * see this transaction's own uncommitted writes or participate in its lock
 * - `pool.query()` from inside `callback` would run on a DIFFERENT
 * connection, outside this transaction entirely.
 *
 * The ROLLBACK itself is guarded, not just awaited: it can reject on its
 * own (a broken connection, or the backend having already aborted the
 * statement via `statement_timeout`), and an unguarded `await` there would
 * let THAT rejection replace the caller's own error before `throw err` is
 * ever reached - turning an actionable AppError (e.g. recordPayment's 402
 * card decline) into a generic 500. The ORIGINAL error always wins; a
 * failed ROLLBACK is only logged, for ops visibility.
 *
 * `release()`'s argument is a boolean destroy flag, not a place to hand it
 * an error object - and the two cases genuinely differ. A SUCCESSFUL
 * ROLLBACK restores the connection to a clean, idle state regardless of
 * WHY the callback threw, so an ordinary business error (a 402 card
 * decline, a validation AppError - `callback` can throw these routinely,
 * not just as a rare edge case) must not pay for a destroyed connection
 * and a fresh reconnect on the next request; that would turn expected,
 * frequent outcomes into avoidable pool churn. Only a ROLLBACK that itself
 * FAILS leaves the connection's state genuinely uncertain - that is the
 * one case `release(true)` destroys it for, rather than risking the next
 * caller checking out a session nobody actually confirmed is clean.
 */
export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    client.release();
    return result;
  } catch (err) {
    let rollbackFailed = false;
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      rollbackFailed = true;
      logger.error({ err: rollbackErr }, 'ROLLBACK failed after a transaction error');
    }
    client.release(rollbackFailed);
    throw err;
  }
}
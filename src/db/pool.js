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
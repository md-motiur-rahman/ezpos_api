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
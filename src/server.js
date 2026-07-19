import app from './app.js';
import config from './config/index.js';
import { checkDbConnection } from './db/pool.js';
import { logger } from './utils/logger.js';

let server;

try {
  await checkDbConnection();
  logger.info('Database connection verified.');
} catch (err) {
  logger.error({ err }, 'Failed to connect to the database at boot');
  process.exit(1);
}

server = app.listen(config.env.port, () => {
  logger.info(`POS API running in ${config.env.nodeEnv} mode on port ${config.env.port}`);
});

// Crash safety net - if a bug somewhere throws outside of Express's request
// cycle (e.g. inside a background job or a stray promise, both coming in
// later modules), log it clearly and shut down cleanly rather than leaving
// the process in a broken, half-alive state.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception - shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled promise rejection - shutting down');
  process.exit(1);
});

// Graceful shutdown - important for a system that will later hold
// open WebSocket connections (KDS) and background jobs (offline sync).
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
});
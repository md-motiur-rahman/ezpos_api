import app from './app.js';
import config from './config/index.js';
import { checkDbConnection } from './db/pool.js';
import { logger } from './utils/logger.js';
import { attachKdsSocketServer } from './modules/kds/kdsSocket.js';

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

// Module 10.1 - the KDS WebSocket surface. Attached to the http.Server that
// app.listen() returns, NOT mounted in app.js: a WebSocket upgrade never
// reaches Express (Node routes upgrade requests only to 'upgrade' listeners),
// so this is the correct and only place it can hook in. Deliberately after
// listen() so the server object exists to attach to.
const kdsSocketServer = attachKdsSocketServer(server);

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

/**
 * Graceful shutdown - important for a system that now genuinely does hold
 * open WebSocket connections (KDS, 10.1) and background jobs (offline sync).
 *
 * The KDS sockets are closed BEFORE server.close() so connected kitchen
 * screens are torn down deliberately (and the heartbeat interval cleared)
 * rather than being left to die with the process.
 *
 * VERIFIED EMPIRICALLY, and NOT for the reason first assumed: the process
 * was checked to still exit cleanly (~1s) with a live KDS socket connected
 * even when this close() call was removed entirely. An upgraded socket is
 * detached from the http.Server's tracked connections, so server.close()
 * does not wait on it - i.e. this line prevents an untidy teardown, not a
 * hang. Recorded here because the opposite (that it would hang) is the
 * intuitive assumption and would be wrong.
 */
function shutdown(signal) {
  logger.info(`${signal} received. Shutting down gracefully...`);
  kdsSocketServer.close();
  server.close(() => {
    logger.info('Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

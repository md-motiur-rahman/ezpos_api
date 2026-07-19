import app from './app.js';
import config from './config/index.js';
import { checkDbConnection } from './db/pool.js';

let server;

try {
  await checkDbConnection();
  console.log('Database connection verified.');
} catch (err) {
  console.error('Failed to connect to the database at boot:', err.message);
  process.exit(1);
}

server = app.listen(config.env.port, () => {
  console.log(
    `POS API running in ${config.env.nodeEnv} mode on port ${config.env.port}`
  );
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
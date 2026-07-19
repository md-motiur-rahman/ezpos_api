import pino from 'pino';
import config from '../config/index.js';

/**
 * Shared logger for the whole app. Use this instead of console.log/console.error
 * everywhere - it gives consistent, leveled, structured logs that are easy to
 * search/filter once deployed (by level, by request id, etc.).
 */
export const logger = pino({
  level: config.env.isProduction ? 'info' : 'debug',
  transport: config.env.isProduction
    ? undefined // raw JSON in production - what log platforms (Render, etc.) want
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
});
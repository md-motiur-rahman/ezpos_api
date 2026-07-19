import { env } from './env.js';

/**
 * Single entry point for all app configuration.
 * As later modules are built (DB in 0.3, JWT in Module 1, Stripe in
 * Module 3, etc.), their config objects get imported and added here,
 * so the rest of the app only ever imports from 'src/config/index.js'
 * and never touches process.env directly.
 */
const config = {
  env,
};

export default config;
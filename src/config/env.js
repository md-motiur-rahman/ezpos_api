import dotenv from 'dotenv';

// Load the correct .env file based on NODE_ENV.
// e.g. NODE_ENV=development -> .env.development
// Falls back to plain .env if a NODE_ENV-specific file isn't found.
const nodeEnv = process.env.NODE_ENV || 'development';
dotenv.config({ path: `.env.${nodeEnv}` });
dotenv.config(); // does not override already-set vars; just fills gaps

/**
 * List every environment variable this module of the app requires.
 * As later modules (DB, JWT, Stripe, etc.) are built, they will add
 * their own required keys here so the app fails fast at boot instead
 * of crashing later mid-request with a confusing error.
 */
const requiredVars = [
  'PORT',
  'NODE_ENV',
  'DATABASE_URL',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'FRONTEND_URL',
  'JWT_ACCESS_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_SHOP_PRICE_ID',
  'STRIPE_ADDON_HEALTH_SAFETY_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
];

function validateEnv() {
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Check your .env.${nodeEnv} file against .env.example.`
    );
  }
}

validateEnv();

/**
 * A whole, non-negative count from an OPTIONAL env var — unset or blank
 * means "use the default", same as this file's existing `|| default`
 * pattern for everything else optional. Anything present but not a clean
 * whole number (a typo like "fifty", a stray "50 requests", a negative)
 * fails BOOT rather than being silently coerced: `Number('fifty')` is NaN,
 * and every `>= dailyLimit` comparison the scan limit is checked with is
 * false against NaN, so a typo here doesn't just misconfigure the limit,
 * it turns it off entirely with nothing anywhere to say so. Caught here,
 * at startup, is much cheaper than caught by a shop's Gemini bill.
 */
function parseOptionalCountEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole non-negative number, got "${raw}".`);
  }
  return parsed;
}

// Comma-separated list of origins allowed to call this API from a browser
// (the Next.js dashboard, and later any other web client). Not required in
// development - if left empty locally, all origins are allowed for convenience.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Optional, opt-in, empty by default. A single domain suffix (e.g.
// '.vercel.app') whose subdomains may call this API from a browser, so that
// Vercel PREVIEW deployments - which get a fresh hostname on every deploy and
// therefore can never appear in the exact list above - are not all blocked by
// CORS. See isAllowedPreviewOrigin in app.js for how strictly it is matched.
const corsAllowedPreviewSuffix = (process.env.CORS_ALLOWED_PREVIEW_SUFFIX || '').trim();

export const env = {
  nodeEnv: process.env.NODE_ENV,
  port: Number(process.env.PORT),
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: process.env.NODE_ENV === 'development',
  isStaging: process.env.NODE_ENV === 'staging',
  isTest: process.env.NODE_ENV === 'test',
  corsAllowedOrigins,
  corsAllowedPreviewSuffix,
  databaseUrl: process.env.DATABASE_URL,
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  frontendUrl: process.env.FRONTEND_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeShopPriceId: process.env.STRIPE_SHOP_PRICE_ID,
  // Keyed by addon_type so adding a future add-on is one env var + one entry
  // here, with no other structural change.
  stripeAddonPriceIds: {
    health_safety: process.env.STRIPE_ADDON_HEALTH_SAFETY_PRICE_ID,
  },
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,

  // --- Receipt scanning (10.5), all optional: absent means the feature is
  // simply off (the frontend falls back to reading the receipt on-device)
  // rather than the app failing to start. ---
  geminiApiKey: process.env.GEMINI_API_KEY || null,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  receiptScanDailyLimit: parseOptionalCountEnv('RECEIPT_SCAN_DAILY_LIMIT', 50),
  receiptScanMonthlyLimit: parseOptionalCountEnv('RECEIPT_SCAN_MONTHLY_LIMIT', 500),
};
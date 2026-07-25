import dotenv from "dotenv";

// Load the correct .env file based on NODE_ENV.
// e.g. NODE_ENV=development -> .env.development
// Falls back to plain .env if a NODE_ENV-specific file isn't found.
const nodeEnv = process.env.NODE_ENV || "development";
dotenv.config({ path: `.env.${nodeEnv}` });
dotenv.config(); // does not override already-set vars; just fills gaps

/**
 * List every environment variable this module of the app requires.
 * As later modules (DB, JWT, Stripe, etc.) are built, they will add
 * their own required keys here so the app fails fast at boot instead
 * of crashing later mid-request with a confusing error.
 */
const requiredVars = [
  "PORT",
  "NODE_ENV",
  "DATABASE_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "FRONTEND_URL",
  'JWT_ACCESS_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_SHOP_PRICE_ID',
];

function validateEnv() {
  const missing = requiredVars.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Check your .env.${nodeEnv} file against .env.example.`,
    );
  }
}

validateEnv();

// Comma-separated list of origins allowed to call this API from a browser
// (the Next.js dashboard, and later any other web client). Not required in
// development - if left empty locally, all origins are allowed for convenience.
const corsAllowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  nodeEnv: process.env.NODE_ENV,
  port: Number(process.env.PORT),
  isProduction: process.env.NODE_ENV === "production",
  isDevelopment: process.env.NODE_ENV === "development",
  isStaging: process.env.NODE_ENV === "staging",
  isTest: process.env.NODE_ENV === "test",
  corsAllowedOrigins,
  databaseUrl: process.env.DATABASE_URL,
  resendApiKey: process.env.RESEND_API_KEY,
  emailFrom: process.env.EMAIL_FROM,
  frontendUrl: process.env.FRONTEND_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  stripeShopPriceId: process.env.STRIPE_SHOP_PRICE_ID,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  
};

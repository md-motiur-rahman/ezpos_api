import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import config from './config/index.js';
import { checkDbConnection } from './db/pool.js';
import { logger } from './utils/logger.js';
import { AppError } from './utils/AppError.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import meRoutes from './modules/auth/me.routes.js';
import companyRoutes from './modules/company/company.routes.js';
import shopRoutes from './modules/shop/shop.routes.js';
import staffRoutes from './modules/staff/staff.routes.js';
import webhookRoutes from './modules/billing/billing.routes.js';
import staffAuthRoutes from './modules/staffAuth/staffAuth.routes.js';
import staffPermissionRoutes from './modules/staff/staffPermission.routes.js';
import rotaRoutes from './modules/rota/rota.routes.js';
import swapRequestRoutes from './modules/rota/swapRequest.routes.js';
import attendanceRoutes from './modules/rota/attendance.routes.js';
import shopMenuRoutes from './modules/menu/shopMenu.routes.js';
import inventoryRoutes from './modules/inventory/inventory.routes.js';
import inventoryOverviewRoutes from './modules/inventory/inventoryOverview.routes.js';
import supplierRoutes from './modules/suppliers/supplier.routes.js';
import purchaseOrderRoutes from './modules/purchaseOrders/purchaseOrder.routes.js';
import wastageLogRoutes from './modules/wastage/wastageLog.routes.js';
import inventoryScanRoutes from './modules/healthSafety/inventoryScan.routes.js';
import orderRoutes from './modules/orders/order.routes.js';

const app = express();

/**
 * Render (and any reverse proxy) terminates TLS and forwards to this process,
 * so without this every request's `req.ip` is the PROXY's address rather than
 * the client's. That silently breaks both rate limiters below: the global one
 * would key every tenant in the system to a single bucket, turning a
 * 300-per-15-min PER-CLIENT limit into a 300-per-15-min limit for the ENTIRE
 * platform, and the staff-login limiter's deliberate (IP, shopId) keying
 * (CLAUDE.md section 5) would collapse to per-shop-globally - so several
 * tills in one busy shop could lock each other out.
 *
 * The value is 1, NOT `true`, and that distinction is the security-critical
 * part. `true` trusts the whole X-Forwarded-For chain, which makes its
 * LEFTMOST entry authoritative - and that entry is supplied by the client, so
 * anyone could spoof an IP per request and defeat rate limiting entirely.
 * A fixed hop count only ever trusts addresses appended by infrastructure we
 * actually control.
 *
 * 1 is correct for this deployment: render.yaml declares a single
 * `type: web` service with no CDN in front of it. If a CDN (Cloudflare etc.)
 * is ever added, this becomes 2 - and the failure mode of leaving it at 1 is
 * safe, just less precise: req.ip falls back to the CDN's address, which is
 * exactly today's behaviour and still not client-controllable. Under-counting
 * hops degrades; over-counting is what opens the hole.
 */
app.set('trust proxy', 1);

// --- CORS ---

/**
 * Vercel gives every preview deployment its OWN hostname
 * (`<project>-git-<branch>-<scope>.vercel.app`), and it changes on each
 * deploy - so an exact-match allow-list can never contain them, and every
 * preview would be blocked by CORS. That matters in practice: previews are
 * how work in progress actually gets shown to someone before it is merged.
 *
 * `CORS_ALLOWED_PREVIEW_SUFFIX` opts into matching by SUFFIX instead
 * (e.g. `.vercel.app`), on top of the exact list. Deliberately opt-in and
 * empty by default: this is a genuine widening of who may call the API from a
 * browser, so it must be a decision someone makes, not a default. Set it to
 * your own preview domain and nothing else.
 *
 * Still strict about HOW it matches - `https://` scheme required, and the
 * suffix must be preceded by at least one more label. Without the scheme
 * check `http://evil.vercel.app` would pass; without the label check a
 * hostile `evil-vercel.app` registration would match a bare `vercel.app`
 * suffix. Origins are compared lowercase because a browser may vary case in
 * the host.
 */
export function isAllowedPreviewOrigin(origin, suffix) {
  if (!suffix) {
    return false;
  }
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const normalized = suffix.toLowerCase().startsWith('.')
    ? suffix.toLowerCase()
    : `.${suffix.toLowerCase()}`;
  return host.endsWith(normalized) && host.length > normalized.length;
}

const corsOptions = {
  origin(origin, callback) {
    const { corsAllowedOrigins, corsAllowedPreviewSuffix, isDevelopment } = config.env;
    if (!origin) return callback(null, true);
    if (isDevelopment && corsAllowedOrigins.length === 0) {
      return callback(null, true);
    }
    if (corsAllowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    if (isAllowedPreviewOrigin(origin, corsAllowedPreviewSuffix)) {
      return callback(null, true);
    }
    return callback(new AppError('Not allowed by CORS', 403));
  },
  credentials: true,
};

// --- Rate limiting ---

/**
 * 300 per IP per 15 minutes in every real environment. Production behaviour is
 * completely unchanged by the test branch below.
 *
 * Raised to an unreachable ceiling under NODE_ENV=test as DEFENCE against a
 * latent fragility, not as a fix for any observed failure - stated plainly
 * because it was first added on a WRONG diagnosis and the measurements did not
 * support it. In the suite every request comes from 127.0.0.1, and `node
 * --test` gives each test FILE its own process, so each file spends against
 * its own 300-request budget under one shared key. Measured across a full
 * run, the lowest remaining on THIS limiter was 36 - i.e. some single file
 * already consumes ~264 of its 300 (88%). Nothing has crossed the line yet,
 * but a file that grows a little would, and the failure mode is horrible to
 * diagnose: the 429 arrives as an error envelope, so the test reads a missing
 * field off it and dies with a TypeError naming neither rate limiting nor the
 * real cause.
 *
 * The project already documents this hazard for the STAFF-LOGIN limiter
 * (CLAUDE.md section 5: keep per-file login counts reasonable, split files if
 * needed). This is the same trap one level up, previously unnoted.
 *
 * The middleware stays MOUNTED and active in test - headers are still emitted
 * and the code path still exercised - the ceiling is simply out of reach for
 * one file. That beats skipping the middleware (which would stop exercising
 * it) and beats splitting whichever file is at 264, which only buys headroom
 * until the next one grows.
 *
 * The STAFF-LOGIN limiter (staffAuth.routes.js, 10 per 15 min) is deliberately
 * NOT relaxed - staffAuth.test.js genuinely asserts its 429.
 */
const RATE_LIMIT_MAX = config.env.isTest ? 1_000_000 : 300;

const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: RATE_LIMIT_MAX, // requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many requests, please try again later.' } },
});

// --- Core middleware ---
app.use(helmet());
app.use(cors(corsOptions));
app.use(rateLimiter);
app.use(pinoHttp({ logger })); // structured request logging (method, path, status, duration)

// --- Stripe webhooks ---
// Mounted BEFORE express.json() deliberately: signature verification needs the
// raw request body, which express.json() would otherwise have already parsed.
app.use('/api/webhooks', webhookRoutes);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Health check ---
app.get('/health', async (req, res) => {
  try {
    await checkDbConnection();
    res.status(200).json({
      status: 'ok',
      db: 'connected',
      environment: config.env.nodeEnv,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      db: 'unavailable',
      environment: config.env.nodeEnv,
      timestamp: new Date().toISOString(),
    });
  }
});

// --- Module routes ---
app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
// Independent mount (Module 7.8), registered BEFORE the broader /api/companies
// mount below, same load-bearing reasoning as the /api/shops block further
// down: '/api/companies' is a PREFIX of '/api/companies/mine/inventory-overview',
// so registering the broad mount first would let this request enter
// companyRoutes first. No route inside companyRoutes currently matches this
// path, so it would still fall through correctly today - but that's an
// accident of company.routes.js having no catch-all, not a guarantee, so this
// stays above the broad mount on the same principle as every /api/shops/:shopId/*
// route.
app.use('/api/companies/mine/inventory-overview', inventoryOverviewRoutes);
app.use('/api/companies', companyRoutes);
// Independent mount (Module 4.5), registered BEFORE the broader /api/shops
// mount below - deliberately, and load-bearing. Express tries app.use()
// prefixes in registration order; /api/shops is a PREFIX of
// /api/shops/:shopId/staff (and every other /api/shops/:shopId/* route
// below it), so if the broad mount were registered first it would swallow
// every one of these more specific requests into shopRoutes' owner-only
// requireAuth before the correct router ever got a chance to run.
// EVERY /api/shops/:shopId/* mount below MUST stay above the plain
// '/api/shops' line for this exact reason - confirmed the hard way (7.7):
// wastage-logs was mounted AFTER '/api/shops' by mistake, and every staff
// token hitting it got silently swallowed into requireAuth, producing a
// uniform 401 regardless of the actor's actual role or permissions.
app.use('/api/shops/:shopId/staff', staffRoutes);
app.use('/api/shops/:shopId/rota-shifts', rotaRoutes);
app.use('/api/shops/:shopId/swap-requests', swapRequestRoutes);
app.use('/api/shops/:shopId/attendance', attendanceRoutes);
app.use('/api/shops/:shopId/menu', shopMenuRoutes);
app.use('/api/shops/:shopId/inventory-items', inventoryRoutes);
app.use('/api/shops/:shopId/suppliers', supplierRoutes);
app.use('/api/shops/:shopId/purchase-orders', purchaseOrderRoutes);
app.use('/api/shops/:shopId/wastage-logs', wastageLogRoutes);
app.use('/api/shops/:shopId/inventory-scans', inventoryScanRoutes);
app.use('/api/shops/:shopId/orders', orderRoutes);
app.use('/api/shops', shopRoutes);
app.use('/api/staff-auth', staffAuthRoutes);
app.use('/api/staff-permissions', staffPermissionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

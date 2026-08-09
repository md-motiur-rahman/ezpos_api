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
import supplierRoutes from './modules/suppliers/supplier.routes.js';
import purchaseOrderRoutes from './modules/purchaseOrders/purchaseOrder.routes.js';
import wastageLogRoutes from './modules/wastage/wastageLog.routes.js';

const app = express();

// --- CORS ---
const corsOptions = {
  origin(origin, callback) {
    const { corsAllowedOrigins, isDevelopment } = config.env;
    if (!origin) return callback(null, true);
    if (isDevelopment && corsAllowedOrigins.length === 0) {
      return callback(null, true);
    }
    if (corsAllowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new AppError('Not allowed by CORS', 403));
  },
  credentials: true,
};

// --- Rate limiting ---
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // requests per IP per window
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
app.use('/api/shops', shopRoutes);
app.use('/api/staff-auth', staffAuthRoutes);
app.use('/api/staff-permissions', staffPermissionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
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

const app = express();

// --- CORS ---
// Only allow browsers from known origins (the Next.js dashboard, etc.) to
// call this API. Requests with no Origin header (native mobile apps, curl,
// server-to-server calls) are always allowed - "Origin" is a browser concept.
// In development, an empty allow-list means "allow everything" for convenience.
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
// Global safety net against abuse/brute-force. Stricter, endpoint-specific
// limits (e.g. PIN login) will be added in their own modules later.
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(pinoHttp({ logger })); // structured request logging (method, path, status, duration)

// --- Health check ---
// Used to verify the API is up (load balancers, deploy checks, manual testing).
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
// e.g. app.use('/api/companies', companyRoutes); <- Module 2

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
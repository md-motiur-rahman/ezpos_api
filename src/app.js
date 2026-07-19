import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import config from './config/index.js';
import { checkDbConnection } from './db/pool.js';

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
    const err = new Error('Not allowed by CORS');
    err.status = 403;
    return callback(err);
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

// --- Module routes will be mounted here as they're built ---
// e.g. app.use('/api/auth', authRoutes);   <- Module 1
// e.g. app.use('/api/companies', companyRoutes); <- Module 2

// --- 404 fallback for unmatched routes ---
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    },
  });
});

// --- Basic error fallback ---
// NOTE: This is intentionally minimal. Full centralized error handling
// (custom error classes, structured error codes, logging integration)
// is built in Module 0.4. This exists only so an unexpected error
// doesn't crash the process before then.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: {
      message: config.env.isProduction ? 'Internal server error' : err.message,
    },
  });
});

export default app;
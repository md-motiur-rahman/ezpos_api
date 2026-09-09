import config from '../config/index.js';

const REFRESH_TOKEN_COOKIE = 'refreshToken';
const REFRESH_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // matches auth.service.js's REFRESH_TOKEN_TTL_MS

/**
 * The dashboard (ezposfrontend.vercel.app) and this API (onrender.com) are
 * different origins, so the browser only sends this cookie back cross-site
 * if it's SameSite=None + Secure - Lax/Strict are same-site-only and would
 * silently never be sent. Secure requires HTTPS, which local dev doesn't
 * have, so dev falls back to Lax/non-Secure (same-origin there anyway).
 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: !config.env.isDevelopment,
    sameSite: config.env.isDevelopment ? 'lax' : 'none',
    path: '/api/auth',
  };
}

export function setRefreshTokenCookie(res, token) {
  res.cookie(REFRESH_TOKEN_COOKIE, token, { ...cookieOptions(), maxAge: REFRESH_TOKEN_MAX_AGE_MS });
}

export function clearRefreshTokenCookie(res) {
  res.clearCookie(REFRESH_TOKEN_COOKIE, cookieOptions());
}

export function getRefreshTokenFromRequest(req) {
  return req.cookies?.[REFRESH_TOKEN_COOKIE];
}

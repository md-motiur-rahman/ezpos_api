import jwt from 'jsonwebtoken';
import config from '../config/index.js';

const ACCESS_TOKEN_TTL = '15m';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.env.jwtAccessSecret, {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/** Throws jwt's own error (expired/invalid) - requireAuth middleware catches it. */
export function verifyAccessToken(token) {
  return jwt.verify(token, config.env.jwtAccessSecret);
}
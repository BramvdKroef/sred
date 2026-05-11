import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signSession(user) {
  return jwt.sign(
    { uid: user.id, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtTtlSeconds, issuer: 'sred', subject: String(user.id) },
  );
}

export function verifySession(token) {
  return jwt.verify(token, config.jwtSecret, { issuer: 'sred' });
}

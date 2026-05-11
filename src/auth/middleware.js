import { verifySession } from './jwt.js';
import { db } from '../db/index.js';
import { unauthorized, forbidden } from '../lib/errors.js';

export function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) throw unauthorized();
    const payload = verifySession(m[1]);
    const user = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(payload.uid);
    if (!user || user.status !== 'active') throw unauthorized('user not active');
    req.user = user;
    next();
  } catch (e) {
    next(e instanceof Error && 'status' in e ? e : unauthorized());
  }
}

export function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== role) return next(forbidden(`requires role: ${role}`));
    next();
  };
}

export const requireAdmin = requireRole('admin');

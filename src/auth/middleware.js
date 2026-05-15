import { verifySession } from './jwt.js';
import { db } from '../db/index.js';
import { unauthorized, forbidden } from '../lib/errors.js';
import { log } from '../lib/logger.js';

export function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) throw unauthorized();
    const payload = verifySession(m[1]);
    const user = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(payload.uid);
    if (!user || user.status !== 'active') {
      // Audit server-side so admins keep observability, but surface the
      // generic 401 to the caller — otherwise the response distinguishes
      // "valid token for an inactive/deleted user" from "bad token", which
      // confirms to an attacker that the user_id in the JWT exists.
      log.warn('auth_inactive_user_attempt', {
        user_id: payload.uid,
        reason: user ? 'inactive' : 'not_found',
      });
      throw unauthorized();
    }
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

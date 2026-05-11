import { db } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/random.js';
import { unauthorized } from '../lib/errors.js';

export function mintRefreshToken(userId) {
  const raw = randomToken(32);
  const tokenHash = sha256(raw);
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  ).run(userId, tokenHash, expiresAt);
  return { raw, expiresAt };
}

// Verify the presented refresh token, mark it revoked (rotation), and
// return the user it belongs to. Throws unauthorized if invalid.
export function consumeRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') throw unauthorized('refresh_token required');
  const tokenHash = sha256(rawToken);
  const row = db.prepare(
    `SELECT rt.*, u.id AS user_id, u.email, u.name, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ?`
  ).get(tokenHash);
  if (!row) throw unauthorized('invalid refresh token');
  if (row.revoked_at) throw unauthorized('refresh token already used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('refresh token expired');
  if (row.status !== 'active') throw unauthorized('user not active');

  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = datetime('now'), last_used_at = datetime('now') WHERE id = ?`
  ).run(row.id);

  return { id: row.user_id, email: row.email, name: row.name, role: row.role, status: row.status };
}

export function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const tokenHash = sha256(rawToken);
  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`
  ).run(tokenHash);
}

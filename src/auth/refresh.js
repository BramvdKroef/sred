import { db } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/random.js';
import { unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

export function mintRefreshToken(userId) {
  // Opportunistically prune this user's expired rows before minting a new
  // one. Negligible cost (indexed on user_id) and bounds long-term growth
  // for a user who rotates daily for years.
  db.prepare(
    `DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at < datetime('now')`
  ).run(userId);
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
//
// Refresh-token theft handling: if the presented token is found but is
// already revoked, treat it as evidence of theft. Atomically revoke every
// still-active refresh token for that user (forcing both the legitimate
// user and the attacker to re-authenticate) and write an audit-log row,
// then surface the standard unauthorized error.
export function consumeRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') throw unauthorized('refresh_token required');
  const tokenHash = sha256(rawToken);
  const row = db.prepare(
    `SELECT rt.*, u.id AS user_id, u.email, u.name, u.role, u.status
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ?`
  ).get(tokenHash);
  if (!row) throw unauthorized('invalid refresh token');
  if (row.revoked_at) {
    // Replay of an already-rotated token => suspected theft. Revoke the
    // whole family for this user and audit, atomically.
    const handleReplay = db.transaction(() => {
      db.prepare(
        `UPDATE refresh_tokens
            SET revoked_at = datetime('now')
          WHERE user_id = ? AND revoked_at IS NULL`
      ).run(row.user_id);
      const before = {
        token_id: row.id,
        user_id: row.user_id,
        original_revoked_at: row.revoked_at,
      };
      audit(row.user_id, 'refresh_replay_detected', 'refresh_token', row.id, before, undefined);
    });
    handleReplay();
    throw unauthorized('refresh token already used');
  }
  // Expired tokens and deactivated users both surface as the same
  // 'invalid refresh token' message so an attacker who has a stolen token
  // can't tell whether the account exists / is active by error message
  // (or by timing — both paths short-circuit before the UPDATE below).
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('invalid refresh token');
  if (row.status !== 'active') throw unauthorized('invalid refresh token');

  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?`
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

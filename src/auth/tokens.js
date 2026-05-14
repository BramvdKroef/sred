import { db } from '../db/index.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../lib/random.js';
import { unauthorized, badRequest } from '../lib/errors.js';

const TTL_MINUTES = {
  invite: () => config.inviteTtlMinutes,
  recovery: () => config.recoveryTtlMinutes,
  add_device: () => config.addDeviceTtlMinutes,
};

export function mintEmailToken(userId, purpose) {
  if (!TTL_MINUTES[purpose]) throw badRequest(`unknown token purpose: ${purpose}`);
  const raw = randomToken(32);
  const tokenHash = sha256(raw);
  const ttl = TTL_MINUTES[purpose]();
  const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
  db.prepare(
    `INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)`
  ).run(userId, tokenHash, purpose, expiresAt);
  return { raw, expiresAt };
}

export function findValidEmailToken(rawToken, expectedPurpose) {
  if (!rawToken) throw unauthorized('missing token');
  if (!expectedPurpose) throw badRequest('expected purpose required');
  const accepted = Array.isArray(expectedPurpose) ? expectedPurpose : [expectedPurpose];
  for (const p of accepted) {
    if (!TTL_MINUTES[p]) throw badRequest(`unknown token purpose: ${p}`);
  }
  const tokenHash = sha256(rawToken);
  const row = db.prepare(
    `SELECT t.*, u.email, u.name, u.role, u.status AS user_status
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(tokenHash);
  if (!row) throw unauthorized('invalid token');
  if (row.consumed_at) throw unauthorized('token already used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('token expired');
  // Purpose mismatch is reported with the same "invalid token" shape as an
  // unknown token, so callers can't enumerate purposes by error message.
  if (!accepted.includes(row.purpose)) throw unauthorized('invalid token');
  return row;
}

// Marks the row consumed_at and returns the number of rows affected. A
// caller MUST check the return value: a zero means the id was unknown or
// the row was already consumed (a race or a tampered request), and the
// caller should refuse to proceed with whatever action the consume was
// meant to gate (typically by throwing unauthorized('invalid token')).
export function consumeEmailToken(tokenId) {
  const info = db.prepare(
    `UPDATE email_tokens SET consumed_at = datetime('now')
       WHERE id = ? AND consumed_at IS NULL`
  ).run(tokenId);
  return info.changes;
}

export function buildMagicLink(rawToken) {
  // First entry in config.origins is the canonical outbound origin.
  // Multiple origins are supported for WebAuthn verification (tunnel/preview
  // domains), but a magic link must point at a single landing page.
  const canonical = config.origins[0];
  return `${canonical}/enroll?token=${encodeURIComponent(rawToken)}`;
}

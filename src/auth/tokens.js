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

export function findValidEmailToken(rawToken) {
  if (!rawToken) throw unauthorized('missing token');
  const tokenHash = sha256(rawToken);
  const row = db.prepare(
    `SELECT t.*, u.email, u.name, u.role, u.status AS user_status
       FROM email_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`
  ).get(tokenHash);
  if (!row) throw unauthorized('invalid token');
  if (row.consumed_at) throw unauthorized('token already used');
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('token expired');
  return row;
}

export function consumeEmailToken(tokenId) {
  db.prepare(`UPDATE email_tokens SET consumed_at = datetime('now') WHERE id = ?`).run(tokenId);
}

export function buildMagicLink(rawToken) {
  return `${config.origin}/enroll?token=${encodeURIComponent(rawToken)}`;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
export const ROOT_DIR = path.resolve(path.dirname(__filename), '..');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function jwtSecret() {
  const v = process.env.JWT_SECRET;
  if (!v) throw new Error('Missing required env var: JWT_SECRET');
  const banned = new Set(['change-me', 'changeme', 'secret', 'dev', 'password']);
  if (banned.has(v.toLowerCase()) || v.length < 32) {
    throw new Error(
      "JWT_SECRET must be a unique random value at least 32 chars long. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
  }
  return v;
}

// Parse the ORIGIN env var as a comma-separated list. A single value continues
// to work (one-element array). Frozen so downstream callers cannot mutate it
// after boot (V-07 hardening: an explicit pinned list is preferred to letting
// an operator relax `ORIGIN` to a regex and lose RP-ID enforcement).
function origins() {
  const raw = process.env.ORIGIN || 'http://localhost:3000';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error('ORIGIN must contain at least one value');
  }
  const isProd = process.env.NODE_ENV === 'production';
  for (const o of list) {
    let parsed;
    try { parsed = new URL(o); }
    catch { throw new Error(`ORIGIN entry is not a valid URL: ${o}`); }
    if (isProd) {
      if (parsed.protocol !== 'https:') {
        throw new Error(`ORIGIN entries must use https:// in production: ${o}`);
      }
    } else {
      // Dev: allow http://localhost*, otherwise still require https.
      const isLocalhostHttp =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname === '127.0.0.1');
      if (parsed.protocol !== 'https:' && !isLocalhostHttp) {
        throw new Error(`ORIGIN entries must use https:// (http:// allowed only for localhost): ${o}`);
      }
    }
  }
  return Object.freeze(list);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: path.resolve(ROOT_DIR, process.env.DATABASE_PATH || './data/sred.db'),
  uploadsDir: path.resolve(ROOT_DIR, process.env.UPLOADS_DIR || './uploads'),

  jwtSecret: jwtSecret(),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS || 3600),
  refreshTtlDays: Number(process.env.REFRESH_TTL_DAYS || 30),

  rpName: process.env.RP_NAME || 'SR&ED Tracker',
  rpId: process.env.RP_ID || 'localhost',
  // WebAuthn expectedOrigin (frozen array; SimpleWebAuthn v11 accepts string[]).
  // First entry is the canonical origin used for outbound magic links and log
  // messages. Multi-tunnel deploys pass a comma-separated ORIGIN.
  origins: origins(),

  inviteTtlMinutes: Number(process.env.INVITE_TTL_MINUTES || 1440),
  recoveryTtlMinutes: Number(process.env.RECOVERY_TTL_MINUTES || 15),
  addDeviceTtlMinutes: Number(process.env.ADD_DEVICE_TTL_MINUTES || 30),

  smtp: {
    host: process.env.SMTP_HOST || '',          // empty = disabled, link still logs
    port: Number(process.env.SMTP_PORT || 1025),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'SR&ED Tracker <no-reply@sred.local>',
  },
};

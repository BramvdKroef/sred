import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { unauthorized, badRequest } from '../lib/errors.js';

// Challenge lifetime — short, since both halves of the ceremony fire within seconds.
const CHALLENGE_TTL_MS = 5 * 60_000;

function storeChallenge({ userId, challenge, kind, context }) {
  // Opportunistic reaper: every insert clears any rows whose 5-minute TTL
  // has already elapsed. Negligible cost (indexed scan over a tiny table
  // bounded by the rate limiter) and eliminates the unbounded-growth class
  // of DoS attack (V-09).
  db.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')`).run();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, context, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(userId ?? null, challenge, kind, context ?? null, expiresAt);
}

function consumeChallenge({ userId, kind }) {
  const row = db.prepare(
    `SELECT * FROM webauthn_challenges
      WHERE kind = ? AND consumed_at IS NULL
        AND (user_id = ? OR (? IS NULL AND user_id IS NULL))
        AND expires_at > datetime('now')
      ORDER BY id DESC LIMIT 1`
  ).get(kind, userId ?? null, userId ?? null);
  if (!row) throw unauthorized('no active challenge');
  db.prepare(`UPDATE webauthn_challenges SET consumed_at = datetime('now') WHERE id = ?`).run(row.id);
  return row;
}

export async function startRegistration({ user, existingCredentials }) {
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(String(user.id)),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map(c => ({
      id: c.credential_id,
      type: 'public-key',
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
  storeChallenge({ userId: user.id, challenge: options.challenge, kind: 'register' });
  return options;
}

export async function finishRegistration({ user, response, label }) {
  const { challenge } = consumeChallenge({ userId: user.id, kind: 'register' });
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('registration verification failed');
  }
  const { credential } = verification.registrationInfo;
  db.prepare(
    `INSERT INTO credentials (user_id, credential_id, public_key, counter, transports, label)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    credential.id,                         // base64url string per SimpleWebAuthn v11
    Buffer.from(credential.publicKey),     // Uint8Array → BLOB
    credential.counter,
    response.response.transports ? JSON.stringify(response.response.transports) : null,
    label ?? null,
  );
  return verification;
}

export async function startLogin({ user }) {
  const creds = user
    ? db.prepare(`SELECT credential_id, transports FROM credentials WHERE user_id = ?`).all(user.id)
    : [];
  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: creds.map(c => ({
      id: c.credential_id,
      type: 'public-key',
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
    userVerification: 'preferred',
  });
  storeChallenge({ userId: user?.id, challenge: options.challenge, kind: 'login' });
  return options;
}

export async function finishLogin({ response }) {
  // Look up credential by base64url id (string) — same shape stored on registration.
  const credRow = db.prepare(`SELECT * FROM credentials WHERE credential_id = ?`).get(response.id);
  if (!credRow) throw unauthorized('unknown credential');
  const { challenge } = consumeChallenge({ userId: credRow.user_id, kind: 'login' });
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: config.origin,
    expectedRPID: config.rpId,
    credential: {
      id: credRow.credential_id,
      publicKey: credRow.public_key,
      counter: credRow.counter,
      transports: credRow.transports ? JSON.parse(credRow.transports) : undefined,
    },
  });
  if (!verification.verified) throw unauthorized('login verification failed');
  // Counter regression check + bump
  if (verification.authenticationInfo.newCounter < credRow.counter) {
    throw unauthorized('counter regression — possible cloned authenticator');
  }
  db.prepare(
    `UPDATE credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?`
  ).run(verification.authenticationInfo.newCounter, credRow.id);
  const user = db.prepare(`SELECT id, email, name, role, status FROM users WHERE id = ?`).get(credRow.user_id);
  if (!user || user.status !== 'active') throw unauthorized('user not active');
  return user;
}

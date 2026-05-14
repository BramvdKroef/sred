// Tests for src/auth/tokens.js — magic-link email tokens.
//
// The module exports:
//   mintEmailToken(userId, purpose)                  -> { raw, expiresAt }
//   findValidEmailToken(rawToken, expectedPurpose)   -> row | throws HttpError(401/400)
//   consumeEmailToken(tokenId)                       -> void (marks consumed_at)
//   buildMagicLink(rawToken)                         -> string
//
// Note: the "consume" step in this module's API is split across
// findValidEmailToken (validates raw + expiry + already-consumed + purpose)
// and consumeEmailToken (marks the row, takes a row id — NOT a raw token).
// These tests exercise the raw-token round-trip via that pair.
//
// consumeEmailToken returns rows-affected (info.changes). Callers must
// treat 0 as "no row was consumed" and refuse the gated action.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;
let mintEmailToken;
let findValidEmailToken;
let consumeEmailToken;
let buildMagicLink;
let config;

before(async () => {
  ctx = await setupTempDb();
  ({ mintEmailToken, findValidEmailToken, consumeEmailToken, buildMagicLink } =
    await import('../../src/auth/tokens.js'));
  ({ config } = await import('../../src/config.js'));
});

after(() => {
  teardownTempDb(ctx);
});

const DATA_TABLES = ['email_tokens', 'users'];

beforeEach(() => {
  ctx.db.pragma('foreign_keys = OFF');
  for (const table of DATA_TABLES) {
    ctx.db.exec(`DELETE FROM ${table}`);
  }
  ctx.db.pragma('foreign_keys = ON');
});

function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

function getTokenRowByHash(hash) {
  return ctx.db.prepare(`SELECT * FROM email_tokens WHERE token_hash = ?`).get(hash);
}

// --- Round-trip --------------------------------------------------------------

test('a freshly-minted token is accepted by findValidEmailToken and yields the right user', () => {
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');

  const row = findValidEmailToken(raw, 'invite');
  assert.equal(row.user_id, userId);
  assert.equal(row.purpose, 'invite');
});

// --- Single-use --------------------------------------------------------------

test('a token cannot be validated again after it has been consumed', () => {
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');

  const row = findValidEmailToken(raw, 'invite');
  consumeEmailToken(row.id);

  assert.throws(
    () => findValidEmailToken(raw, 'invite'),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /already used/);
      return true;
    }
  );
});

// --- consumeEmailToken rows-affected -----------------------------------------

test('consumeEmailToken returns 1 for a fresh token, 0 for the same id on replay', () => {
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');
  const row = findValidEmailToken(raw, 'invite');

  // First consume hits a fresh row.
  assert.equal(consumeEmailToken(row.id), 1);
  // Replay against the same id — already consumed, no row to update.
  assert.equal(consumeEmailToken(row.id), 0);
});

test('consumeEmailToken returns 0 for a non-existent id', () => {
  assert.equal(consumeEmailToken(999_999), 0);
});

test('register/finish-style flow refuses (unauthorized) when consume returns 0', async () => {
  // Mirrors what src/routes/auth.js does on /webauthn/register/finish:
  // it calls consumeEmailToken(tokenRow.id) and treats 0 as a failed
  // single-use guard (concurrent finish, replay, tampered id, etc.).
  const { unauthorized } = await import('../../src/lib/errors.js');
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');
  const tokenRow = findValidEmailToken(raw, 'invite');

  // Simulate a concurrent finish: someone else consumed the row first.
  ctx.db.prepare(
    `UPDATE email_tokens SET consumed_at = datetime('now') WHERE id = ?`
  ).run(tokenRow.id);

  // The route's check: `if (consumeEmailToken(tokenRow.id) === 0) throw ...`
  assert.throws(
    () => {
      if (consumeEmailToken(tokenRow.id) === 0) throw unauthorized('invalid token');
    },
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /invalid token/);
      return true;
    }
  );
});

// --- Hashed-at-rest ----------------------------------------------------------

test('the email_tokens row stores the SHA-256 hash of the raw token, never the raw value', () => {
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');

  // The raw token must not appear anywhere in the row.
  const allRows = ctx.db.prepare(`SELECT * FROM email_tokens`).all();
  assert.equal(allRows.length, 1);
  const stored = allRows[0];
  for (const [col, value] of Object.entries(stored)) {
    if (typeof value === 'string') {
      assert.ok(
        !value.includes(raw),
        `column ${col} unexpectedly contained the raw token`
      );
    }
  }

  // The token_hash column is exactly the hex SHA-256 of the raw.
  assert.equal(stored.token_hash, sha256Hex(raw));
});

// --- Purpose enforcement -----------------------------------------------------

test('mintEmailToken rejects an unknown purpose', () => {
  const userId = insertUser(ctx.db);
  assert.throws(
    () => mintEmailToken(userId, 'not-a-purpose'),
    err => {
      assert.equal(err.status, 400);
      assert.match(err.message, /unknown token purpose/);
      return true;
    }
  );
});

test('the stored row records the purpose it was minted for', () => {
  const userId = insertUser(ctx.db);
  const { raw: inviteRaw } = mintEmailToken(userId, 'invite');
  const { raw: recoveryRaw } = mintEmailToken(userId, 'recovery');
  const { raw: addDeviceRaw } = mintEmailToken(userId, 'add_device');

  assert.equal(getTokenRowByHash(sha256Hex(inviteRaw)).purpose, 'invite');
  assert.equal(getTokenRowByHash(sha256Hex(recoveryRaw)).purpose, 'recovery');
  assert.equal(getTokenRowByHash(sha256Hex(addDeviceRaw)).purpose, 'add_device');
});

test('an invite token is rejected when consumed via the recovery purpose', () => {
  // Cross-purpose use is the original gap that motivated this signature change:
  // a leaked invite token must not validate in a recovery flow.
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');

  // Sanity: the token IS valid under its actual purpose.
  const ok = findValidEmailToken(raw, 'invite');
  assert.equal(ok.purpose, 'invite');

  // And invalid under a different one.
  assert.throws(
    () => findValidEmailToken(raw, 'recovery'),
    err => {
      // CRITICAL: error must be indistinguishable from "unknown token" so an
      // attacker can't enumerate purposes by message comparison.
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /invalid token/);
      return true;
    }
  );
});

test('findValidEmailToken accepts an array of acceptable purposes', () => {
  // The register endpoints accept invite/recovery/add_device interchangeably,
  // so the signature supports passing a list of acceptable purposes.
  const userId = insertUser(ctx.db);
  const { raw: recoveryRaw } = mintEmailToken(userId, 'recovery');

  const row = findValidEmailToken(recoveryRaw, ['invite', 'recovery', 'add_device']);
  assert.equal(row.purpose, 'recovery');

  // Outside the allowlist => same 401 invalid-token shape as above.
  const { raw: inviteRaw } = mintEmailToken(userId, 'invite');
  assert.throws(
    () => findValidEmailToken(inviteRaw, ['recovery', 'add_device']),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /invalid token/);
      return true;
    }
  );
});

test('findValidEmailToken requires an expectedPurpose argument', () => {
  // Forgetting to pass a purpose must NOT silently allow any-purpose use —
  // that would re-introduce the very bug the signature change is meant to
  // close. The error is a 400 (programmer error), not 401.
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'invite');

  assert.throws(
    () => findValidEmailToken(raw),
    err => {
      assert.equal(err.status, 400);
      return true;
    }
  );
});

// --- Expiry ------------------------------------------------------------------

test('an expired token is rejected by findValidEmailToken', () => {
  const userId = insertUser(ctx.db);
  const { raw } = mintEmailToken(userId, 'recovery');

  // Force the row into the past.
  ctx.db.prepare(
    `UPDATE email_tokens SET expires_at = '2020-01-01' WHERE token_hash = ?`
  ).run(sha256Hex(raw));

  assert.throws(
    () => findValidEmailToken(raw, 'recovery'),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /expired/);
      return true;
    }
  );
});

test('expires_at on a freshly-minted token reflects the configured TTL for the purpose', () => {
  const userId = insertUser(ctx.db);
  const beforeTs = Date.now();
  const { raw, expiresAt } = mintEmailToken(userId, 'recovery');
  const afterTs = Date.now();

  const expiresMs = new Date(expiresAt).getTime();
  const ttlMs = config.recoveryTtlMinutes * 60_000;
  // Allow a small window for clock drift between the two Date.now() reads.
  assert.ok(expiresMs >= beforeTs + ttlMs);
  assert.ok(expiresMs <= afterTs + ttlMs);

  // Sanity: the row's expires_at matches the returned one.
  const row = getTokenRowByHash(sha256Hex(raw));
  assert.equal(row.expires_at, expiresAt);
});

// --- Unknown / malformed token ----------------------------------------------

test('findValidEmailToken rejects an unknown token string', () => {
  assert.throws(
    () => findValidEmailToken('definitely-not-a-real-token', 'invite'),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /invalid token/);
      return true;
    }
  );
});

test('findValidEmailToken rejects an empty/missing token', () => {
  assert.throws(
    () => findValidEmailToken('', 'invite'),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /missing token/);
      return true;
    }
  );
  assert.throws(
    () => findValidEmailToken(undefined, 'invite'),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /missing token/);
      return true;
    }
  );
});

// --- buildMagicLink ----------------------------------------------------------

test('buildMagicLink embeds the raw token and the configured ORIGIN', () => {
  const raw = 'abc123-token';
  const link = buildMagicLink(raw);

  assert.ok(link.startsWith(config.origin), `link should start with ORIGIN (${config.origin}): ${link}`);
  assert.ok(link.includes(encodeURIComponent(raw)), `link should contain the raw token: ${link}`);

  // Round-trip: the URL parses and exposes the same token under ?token=.
  const url = new URL(link);
  assert.equal(url.origin + (url.pathname === '/' ? '' : ''), new URL(config.origin).origin);
  assert.equal(url.searchParams.get('token'), raw);
});

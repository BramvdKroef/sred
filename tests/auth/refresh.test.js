// Tests for src/auth/refresh.js — refresh-token mint / consume / revoke.
//
// Strategy mirrors tests/lib/t661.test.js:
//   - One temp SQLite DB per file (before/after hooks).
//   - beforeEach wipes the relevant data tables so each test is isolated.
//   - Scenario builder mints a user + a fresh refresh token.
//
// Coverage focus is the V-03 fix: replay of an already-revoked refresh
// token must revoke every sibling token for that user (the family) and
// write an audit-log row, in addition to throwing unauthorized.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;
let mintRefreshToken;
let consumeRefreshToken;
let revokeRefreshToken;
let sha256;

before(async () => {
  ctx = await setupTempDb();
  // Migration 008 adds BEFORE-DELETE/UPDATE triggers on audit_log to enforce
  // append-only at the DB layer. Tests need to wipe the table between cases,
  // so drop the triggers in this test-only DB. The triggers are tested
  // separately in tests/db/audit-log-append-only.test.js, which uses its own
  // temp DB.
  ctx.db.exec(`DROP TRIGGER IF EXISTS audit_log_no_update`);
  ctx.db.exec(`DROP TRIGGER IF EXISTS audit_log_no_delete`);
  ({ mintRefreshToken, consumeRefreshToken, revokeRefreshToken } =
    await import('../../src/auth/refresh.js'));
  ({ sha256 } = await import('../../src/lib/random.js'));
});

after(() => {
  teardownTempDb(ctx);
});

// Tables touched by these tests. Children-before-parents for FK safety.
const DATA_TABLES = [
  'audit_log',
  'refresh_tokens',
  'users',
];

beforeEach(() => {
  ctx.db.pragma('foreign_keys = OFF');
  for (const table of DATA_TABLES) {
    ctx.db.exec(`DELETE FROM ${table}`);
  }
  ctx.db.pragma('foreign_keys = ON');
});

// --- Helpers -----------------------------------------------------------------

function makeUserWithToken(overrides = {}) {
  const userId = insertUser(ctx.db, overrides);
  const { raw, expiresAt } = mintRefreshToken(userId);
  const row = ctx.db.prepare(
    `SELECT * FROM refresh_tokens WHERE token_hash = ?`
  ).get(sha256(raw));
  return { userId, raw, expiresAt, row };
}

function countActiveTokens(userId) {
  return ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL`
  ).get(userId).n;
}

function getTokenByHash(rawToken) {
  return ctx.db.prepare(
    `SELECT * FROM refresh_tokens WHERE token_hash = ?`
  ).get(sha256(rawToken));
}

// --- mint + consume happy path ----------------------------------------------

test('consume on a freshly minted token returns the user it belongs to', () => {
  const { userId, raw } = makeUserWithToken({ email: 'alice@example.com', name: 'Alice' });
  const user = consumeRefreshToken(raw);
  assert.equal(user.id, userId);
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.name, 'Alice');
  assert.equal(user.status, 'active');
});

test('after consume, the original token row is marked revoked_at', () => {
  const { raw, row } = makeUserWithToken();
  assert.equal(row.revoked_at, null, 'sanity: token starts unrevoked');
  consumeRefreshToken(raw);
  const after = getTokenByHash(raw);
  assert.ok(after.revoked_at, 'revoked_at should be set after consume');
});

test('rotation: caller can mint a fresh token; the new one is unrevoked while the old is revoked', () => {
  const { userId, raw } = makeUserWithToken();
  consumeRefreshToken(raw);

  const next = mintRefreshToken(userId);
  assert.notEqual(next.raw, raw, 'rotated token must differ from the consumed one');

  const oldRow = getTokenByHash(raw);
  const newRow = getTokenByHash(next.raw);
  assert.ok(oldRow.revoked_at, 'old token still revoked after mint');
  assert.equal(newRow.revoked_at, null, 'newly minted token is active');
});

// --- replay / theft branch (V-03) -------------------------------------------

test('replaying a consumed token throws unauthorized AND revokes every sibling token for that user', () => {
  const userId = insertUser(ctx.db);
  // Three live sessions for this user (e.g. laptop, phone, work machine).
  const t1 = mintRefreshToken(userId).raw;
  const t2 = mintRefreshToken(userId).raw;
  const t3 = mintRefreshToken(userId).raw;
  assert.equal(countActiveTokens(userId), 3);

  // Legit user rotates t1; attacker holds the original t1 and replays it.
  consumeRefreshToken(t1);
  assert.equal(countActiveTokens(userId), 2, 'rotation only revokes the consumed token');

  assert.throws(
    () => consumeRefreshToken(t1),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      return true;
    },
  );

  // Every still-active sibling must now be revoked.
  assert.equal(countActiveTokens(userId), 0, 'family-revoke triggered by replay');
  assert.ok(getTokenByHash(t2).revoked_at);
  assert.ok(getTokenByHash(t3).revoked_at);
});

test('replay does not bleed into other users — siblings of unrelated users stay active', () => {
  const victimId = insertUser(ctx.db, { email: 'victim@example.com' });
  const otherId  = insertUser(ctx.db, { email: 'other@example.com' });

  const vToken = mintRefreshToken(victimId).raw;
  const oToken = mintRefreshToken(otherId).raw;

  consumeRefreshToken(vToken);
  assert.throws(() => consumeRefreshToken(vToken));

  // Other user's session must be untouched.
  assert.equal(countActiveTokens(otherId), 1);
  assert.equal(getTokenByHash(oToken).revoked_at, null);
});

test('replay writes a refresh_replay_detected audit_log row scoped to the user + token', () => {
  const userId = insertUser(ctx.db);
  const { raw } = { raw: mintRefreshToken(userId).raw };
  const tokenRow = getTokenByHash(raw);
  consumeRefreshToken(raw);

  assert.throws(() => consumeRefreshToken(raw));

  const logs = ctx.db.prepare(
    `SELECT * FROM audit_log WHERE action = 'refresh_replay_detected'`
  ).all();
  assert.equal(logs.length, 1, 'exactly one audit row for the theft event');
  const entry = logs[0];
  assert.equal(entry.actor_user_id, userId);
  assert.equal(entry.entity_type, 'refresh_token');
  assert.equal(entry.entity_id, tokenRow.id);
  assert.equal(entry.after_json, null);
  const before = JSON.parse(entry.before_json);
  assert.equal(before.token_id, tokenRow.id);
  assert.equal(before.user_id, userId);
  assert.ok(before.original_revoked_at, 'records the original revoked_at timestamp');
});

// --- unknown / expired tokens -----------------------------------------------

test('replaying an unknown token throws unauthorized without writing audit or revoking anything', () => {
  const userId = insertUser(ctx.db);
  mintRefreshToken(userId); // a live unrelated token

  const before = countActiveTokens(userId);
  const auditBefore = ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n;

  assert.throws(
    () => consumeRefreshToken('definitely-not-a-real-token'),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      return true;
    },
  );

  assert.equal(countActiveTokens(userId), before, 'no side effects on active tokens');
  assert.equal(
    ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get().n,
    auditBefore,
    'unknown token must not write audit_log',
  );
});

test('replaying an expired (but never-consumed) token throws unauthorized', () => {
  const { userId, raw } = makeUserWithToken();
  // Backdate expiry to the past directly in the DB; bypasses the 30-day TTL.
  ctx.db.prepare(
    `UPDATE refresh_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?`
  ).run(userId);

  assert.throws(
    () => consumeRefreshToken(raw),
    err => {
      assert.equal(err.status, 401);
      assert.match(err.message, /expired/);
      return true;
    },
  );

  // Expired-but-not-revoked is not theft; the token row should remain
  // unrevoked (the caller didn't actually consume it).
  assert.equal(getTokenByHash(raw).revoked_at, null);
});

// --- revokeRefreshToken smoke ------------------------------------------------

test('revokeRefreshToken revokes exactly the presented token, not the user family', () => {
  const userId = insertUser(ctx.db);
  const a = mintRefreshToken(userId).raw;
  const b = mintRefreshToken(userId).raw;
  assert.equal(countActiveTokens(userId), 2);

  revokeRefreshToken(a);

  assert.ok(getTokenByHash(a).revoked_at, 'presented token is revoked');
  assert.equal(getTokenByHash(b).revoked_at, null, 'sibling is left alone');
  assert.equal(countActiveTokens(userId), 1);
});

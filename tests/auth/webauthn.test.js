// Tests for src/auth/webauthn.js.
//
// What we can cover here:
//   - Challenge management (storeChallenge / consumeChallenge are not exported,
//     so we drive them through the public startRegistration / startLogin /
//     finishRegistration / finishLogin pair and inspect the DB).
//   - The opportunistic reaper that wipes expired webauthn_challenges rows on
//     every storeChallenge call (V-09).
//   - The "no active challenge" 401 path through finishRegistration /
//     finishLogin (consumeChallenge throws unauthorized).
//   - finishLogin against an unknown credential_id throws unauthorized.
//
// What we deliberately CAN'T cover from a unit test:
//   - The verifyRegistrationResponse / verifyAuthenticationResponse happy
//     paths inside @simplewebauthn/server — those require a real authenticator
//     ceremony. Without dependency injection (intentionally out of scope:
//     don't modify src/auth/webauthn.js), the verifier-dependent code paths
//     (credential insertion after registration, counter regression check on
//     login, newCounter bump) are exercised only via error/short-circuit
//     boundaries here. The TEST_STRATEGY_REVIEW.md note covers this.
//
// Strategy mirrors tests/auth/refresh.test.js: temp DB per file, beforeEach
// wipes the relevant tables, scenario builder for users.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;
let startRegistration;
let finishRegistration;
let startLogin;
let finishLogin;

before(async () => {
  ctx = await setupTempDb();
  ({ startRegistration, finishRegistration, startLogin, finishLogin } =
    await import('../../src/auth/webauthn.js'));
});

after(() => {
  teardownTempDb(ctx);
});

// children-before-parents for FK safety.
const DATA_TABLES = ['webauthn_challenges', 'credentials', 'users'];

beforeEach(() => {
  ctx.db.pragma('foreign_keys = OFF');
  for (const table of DATA_TABLES) {
    ctx.db.exec(`DELETE FROM ${table}`);
  }
  ctx.db.pragma('foreign_keys = ON');
});

// --- Helpers -----------------------------------------------------------------

function makeUser(overrides = {}) {
  const id = insertUser(ctx.db, overrides);
  return ctx.db.prepare(`SELECT id, email, name FROM users WHERE id = ?`).get(id);
}

function getChallengeRows(userId, kind) {
  return ctx.db.prepare(
    `SELECT * FROM webauthn_challenges WHERE user_id = ? AND kind = ? ORDER BY id ASC`
  ).all(userId, kind);
}

function countChallenges() {
  return ctx.db.prepare(`SELECT COUNT(*) AS n FROM webauthn_challenges`).get().n;
}

// --- storeChallenge via startRegistration ----------------------------------

test('startRegistration inserts a webauthn_challenges row with kind=register and the user id', async () => {
  const user = makeUser({ email: 'alice@example.com', name: 'Alice' });
  const options = await startRegistration({ user, existingCredentials: [] });

  assert.equal(typeof options.challenge, 'string');
  const rows = getChallengeRows(user.id, 'register');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, 'register');
  assert.equal(row.user_id, user.id);
  assert.equal(row.challenge, options.challenge);
  assert.equal(row.consumed_at, null);
  assert.equal(row.context, null);
  // expires_at is set 5 minutes ahead (CHALLENGE_TTL_MS). Verify it's roughly in
  // the future (between now+1m and now+10m to allow slop).
  const exp = new Date(row.expires_at).getTime();
  const now = Date.now();
  assert.ok(exp > now + 60_000,  `expires_at should be >1 minute ahead, got ${row.expires_at}`);
  assert.ok(exp < now + 600_000, `expires_at should be <10 minutes ahead, got ${row.expires_at}`);
});

test('startLogin with a user inserts a webauthn_challenges row with kind=login', async () => {
  const user = makeUser();
  const options = await startLogin({ user });
  const rows = getChallengeRows(user.id, 'login');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].challenge, options.challenge);
  assert.equal(rows[0].consumed_at, null);
});

test('startLogin without a user inserts a kind=login row with user_id NULL (passkey discovery)', async () => {
  const options = await startLogin({ user: null });
  const row = ctx.db.prepare(
    `SELECT * FROM webauthn_challenges WHERE kind = 'login' AND user_id IS NULL`
  ).get();
  assert.ok(row, 'a user-less login challenge row must exist');
  assert.equal(row.challenge, options.challenge);
});

// --- consumeChallenge picks the most-recent row -----------------------------

test('consumeChallenge picks the most-recent challenge when storeChallenge has been called twice', async () => {
  const user = makeUser();
  // Two registrations in a row; both insert. The most recent should be picked.
  await startRegistration({ user, existingCredentials: [] });
  await startRegistration({ user, existingCredentials: [] });

  const rows = getChallengeRows(user.id, 'register');
  assert.equal(rows.length, 2);
  const newest = rows[rows.length - 1];

  // Drive finishRegistration with a bogus body. consumeChallenge runs first
  // and will mark a row consumed_at — and importantly, it should be the
  // newest one. The verifier downstream will throw, but we only care that
  // the consume step targeted the right row.
  try {
    await finishRegistration({ user, response: { id: 'bogus', response: {} } });
  } catch {
    // expected; downstream verifier will reject. We just inspect the DB.
  }

  const after = getChallengeRows(user.id, 'register');
  const newestAfter = after.find(r => r.id === newest.id);
  const olderAfter  = after.find(r => r.id !== newest.id);
  assert.ok(newestAfter.consumed_at, 'newest row should have been consumed');
  assert.equal(olderAfter.consumed_at, null, 'older row should remain unconsumed');
});

// --- expired challenge is not consumable ------------------------------------

test('finishRegistration throws unauthorized when the only challenge has expired', async () => {
  const user = makeUser();
  await startRegistration({ user, existingCredentials: [] });
  // Backdate every register-challenge for this user.
  ctx.db.prepare(
    `UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z'
      WHERE user_id = ? AND kind = 'register'`
  ).run(user.id);

  await assert.rejects(
    finishRegistration({ user, response: { id: 'x', response: {} } }),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /no active challenge/);
      return true;
    },
  );
});

// --- consumed challenge is not re-consumable --------------------------------

test('finishRegistration throws unauthorized when the challenge has already been consumed', async () => {
  const user = makeUser();
  await startRegistration({ user, existingCredentials: [] });
  // Mark every register-challenge row consumed up-front.
  ctx.db.prepare(
    `UPDATE webauthn_challenges SET consumed_at = datetime('now')
      WHERE user_id = ? AND kind = 'register'`
  ).run(user.id);

  await assert.rejects(
    finishRegistration({ user, response: { id: 'x', response: {} } }),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /no active challenge/);
      return true;
    },
  );
});

// --- wrong-kind challenge ---------------------------------------------------

test('finishLogin throws unauthorized when the only challenge stored is kind=register (wrong kind)', async () => {
  const user = makeUser();
  // Register a credential row so finishLogin's credential lookup passes; the
  // consumeChallenge step is what we're trying to reach.
  ctx.db.prepare(
    `INSERT INTO credentials (user_id, credential_id, public_key, counter)
     VALUES (?, ?, ?, ?)`
  ).run(user.id, 'cred-abc', Buffer.from([1, 2, 3]), 0);

  // Only a "register" challenge exists; finishLogin asks for "login".
  await startRegistration({ user, existingCredentials: [] });

  await assert.rejects(
    finishLogin({ response: { id: 'cred-abc', response: {} } }),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /no active challenge/);
      return true;
    },
  );
});

// --- V-09 opportunistic reaper ---------------------------------------------

test('storeChallenge reaps every expired row in the table on each insert (V-09)', async () => {
  const user = makeUser();
  // Manually insert three "expired" challenge rows for various users / kinds.
  ctx.db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(user.id, 'stale-a', 'register', '2000-01-01T00:00:00.000Z');
  ctx.db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(user.id, 'stale-b', 'login', '2000-01-01T00:00:00.000Z');
  ctx.db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(null, 'stale-c', 'login', '2000-01-01T00:00:00.000Z');
  assert.equal(countChallenges(), 3);

  // Now call startRegistration — its storeChallenge insert opens with a
  // DELETE WHERE expires_at < datetime('now'), then inserts the new row.
  await startRegistration({ user, existingCredentials: [] });

  // All three stale rows gone; exactly one fresh row remains.
  assert.equal(countChallenges(), 1);
  const remaining = ctx.db.prepare(`SELECT * FROM webauthn_challenges`).get();
  assert.notEqual(remaining.challenge, 'stale-a');
  assert.notEqual(remaining.challenge, 'stale-b');
  assert.notEqual(remaining.challenge, 'stale-c');
  assert.equal(remaining.kind, 'register');
  assert.equal(remaining.user_id, user.id);
});

test('storeChallenge does NOT reap rows whose expires_at is still in the future', async () => {
  const user = makeUser();
  // A future-dated challenge from a separate user.
  const otherUserId = insertUser(ctx.db, { email: 'other@example.com' });
  const future = new Date(Date.now() + 60_000).toISOString();
  ctx.db.prepare(
    `INSERT INTO webauthn_challenges (user_id, challenge, kind, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(otherUserId, 'still-valid', 'login', future);

  await startRegistration({ user, existingCredentials: [] });

  // The other user's still-valid row survives the reaper.
  const survived = ctx.db.prepare(
    `SELECT * FROM webauthn_challenges WHERE challenge = 'still-valid'`
  ).get();
  assert.ok(survived, 'still-valid row should not be reaped');
});

// --- finishLogin against unknown credential ---------------------------------

test('finishLogin throws unauthorized when the response.id matches no credential row', async () => {
  // No credentials inserted; the SELECT will return undefined.
  await assert.rejects(
    finishLogin({ response: { id: 'never-registered', response: {} } }),
    err => {
      assert.equal(err.status, 401);
      assert.equal(err.code, 'unauthorized');
      assert.match(err.message, /unknown credential/);
      return true;
    },
  );
});

// --- finishRegistration / finishLogin verifier-dependent paths (error only) -

test('finishRegistration throws on a malformed response body (verifier rejects, consume already ran)', async () => {
  const user = makeUser();
  await startRegistration({ user, existingCredentials: [] });

  // The verifier will throw on a malformed response; we don't care which
  // error (the SimpleWebAuthn library raises a non-HttpError). Asserting
  // "rejects" is sufficient — it pins that the verifier is wired in and
  // a malformed body does NOT silently insert a credential row.
  await assert.rejects(
    finishRegistration({ user, response: { id: 'malformed', response: {} } }),
  );

  // Critical: no credential row inserted on the failure path.
  const creds = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM credentials WHERE user_id = ?`
  ).get(user.id);
  assert.equal(creds.n, 0, 'malformed verifier response must not insert a credential');
});

test('finishLogin against malformed response throws AND does not bump the counter', async () => {
  const user = makeUser();
  ctx.db.prepare(
    `INSERT INTO credentials (user_id, credential_id, public_key, counter)
     VALUES (?, ?, ?, ?)`
  ).run(user.id, 'cred-xyz', Buffer.from([9, 9, 9]), 42);

  await startLogin({ user });

  await assert.rejects(
    finishLogin({ response: { id: 'cred-xyz', response: {} } }),
  );

  // Counter unchanged on the failure path.
  const row = ctx.db.prepare(
    `SELECT counter, last_used_at FROM credentials WHERE credential_id = ?`
  ).get('cred-xyz');
  assert.equal(row.counter, 42, 'counter must not advance when verifier rejects');
  assert.equal(row.last_used_at, null, 'last_used_at must remain null on failure');
});

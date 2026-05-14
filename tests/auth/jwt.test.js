// Tests for src/auth/jwt.js — sign/verify wrappers around jsonwebtoken.
//
// Strategy:
//   - No DB, no temp files. We DO import config.js (transitively via jwt.js),
//     which requires JWT_SECRET to be set to ≥32 chars and not a known weak
//     value BEFORE the module loads. We set that env up here, then dynamically
//     import.
//   - We test the project's verifySession against the real `jsonwebtoken` lib
//     (no mocks) for the negative paths.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Must be set before importing config.js (transitively via jwt.js).
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-only-' + crypto.randomBytes(24).toString('hex');
}

let signSession;
let verifySession;
let jwt;
let config;

before(async () => {
  ({ signSession, verifySession } = await import('../../src/auth/jwt.js'));
  ({ config } = await import('../../src/config.js'));
  jwt = (await import('jsonwebtoken')).default;
});

// --- Tests ------------------------------------------------------------------

test('sign → verify roundtrip preserves uid and role', () => {
  const token = signSession({ id: 42, role: 'admin' });
  assert.equal(typeof token, 'string');

  const decoded = verifySession(token);
  assert.equal(decoded.uid, 42);
  assert.equal(decoded.role, 'admin');
  // signSession sets iss='sred' and sub=String(user.id).
  assert.equal(decoded.iss, 'sred');
  assert.equal(decoded.sub, '42');
  // jsonwebtoken adds iat + exp because we set expiresIn.
  assert.equal(typeof decoded.iat, 'number');
  assert.equal(typeof decoded.exp, 'number');
  assert.ok(decoded.exp > decoded.iat);
});

test('verify of an expired token throws TokenExpiredError', async () => {
  // Mint directly with a 1ms TTL so we don't have to wait a full second.
  const token = jwt.sign(
    { uid: 7, role: 'employee' },
    config.jwtSecret,
    { expiresIn: '1ms', issuer: 'sred', subject: '7' },
  );
  // Give it room to expire (jsonwebtoken compares against clock seconds).
  await new Promise(resolve => setTimeout(resolve, 1100));

  assert.throws(
    () => verifySession(token),
    err => {
      // jsonwebtoken throws TokenExpiredError, which extends JsonWebTokenError.
      assert.equal(err.name, 'TokenExpiredError');
      return true;
    },
  );
});

test('verify of a token signed with the WRONG secret throws', () => {
  const token = jwt.sign(
    { uid: 1, role: 'admin' },
    'wrong-secret-32-chars-or-more-here-xyz',
    { issuer: 'sred', subject: '1', expiresIn: '1h' },
  );
  assert.throws(
    () => verifySession(token),
    err => {
      // Library raises JsonWebTokenError("invalid signature").
      assert.equal(err.name, 'JsonWebTokenError');
      assert.match(err.message, /signature/i);
      return true;
    },
  );
});

test('verify of a token with the WRONG issuer throws', () => {
  const token = jwt.sign(
    { uid: 9, role: 'admin' },
    config.jwtSecret,                       // correct secret
    { issuer: 'not-sred', subject: '9', expiresIn: '1h' },
  );
  assert.throws(
    () => verifySession(token),
    err => {
      assert.equal(err.name, 'JsonWebTokenError');
      assert.match(err.message, /issuer/i);
      return true;
    },
  );
});

test('verify of a malformed token throws', () => {
  assert.throws(
    () => verifySession('not-a-jwt'),
    err => {
      assert.equal(err.name, 'JsonWebTokenError');
      assert.match(err.message, /jwt malformed/i);
      return true;
    },
  );
});

test('verify of an empty-string token throws', () => {
  // jsonwebtoken treats this differently from malformed (it's a "must be
  // provided" path). Either way, we expect a throw — pin whichever it is.
  assert.throws(() => verifySession(''));
});

test('signSession round-trip survives a payload with extra user fields (only uid+role are encoded)', () => {
  const token = signSession({
    id: 11,
    role: 'employee',
    email: 'leak@example.com',     // must NOT end up in the token
    name: 'Should Not Appear',
  });
  const decoded = verifySession(token);
  assert.equal(decoded.uid, 11);
  assert.equal(decoded.role, 'employee');
  assert.equal(decoded.email, undefined);
  assert.equal(decoded.name, undefined);
});

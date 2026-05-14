// Tests for src/auth/middleware.js — requireAuth + requireAdmin.
//
// Strategy:
//   - Set JWT_SECRET (and let setupTempDb pick DATABASE_PATH) BEFORE the
//     production modules import, mirroring tests/auth/refresh.test.js.
//   - Most cases are direct unit tests: build a fake req/res/next, call the
//     middleware function, assert on what `next` was called with.
//   - One end-to-end smoke test boots a tiny express app on an ephemeral
//     port to confirm the integration with errorMiddleware is wired up.
//
// The happy path is exercised transitively by every other integration test,
// so the focus here is the negative branches: missing/malformed/bad/expired
// tokens, deleted users, deactivated users, role mismatch on requireAdmin.
//
// Don't modify src/auth/middleware.js, src/lib/errors.js, or tests/helpers/db.js.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;
let requireAuth;
let requireAdmin;
let requireRole;
let signSession;
let config;
let jwt;

before(async () => {
  ctx = await setupTempDb();
  ({ requireAuth, requireAdmin, requireRole } =
    await import('../../src/auth/middleware.js'));
  ({ signSession } = await import('../../src/auth/jwt.js'));
  ({ config } = await import('../../src/config.js'));
  jwt = (await import('jsonwebtoken')).default;
});

after(() => {
  teardownTempDb(ctx);
});

beforeEach(() => {
  // requireAuth reads a row from users; isolate each test.
  ctx.db.exec(`DELETE FROM users`);
});

// --- Helpers ----------------------------------------------------------------

// Drive a middleware function with a fake req/res/next. Returns
// { err, called } where `called` is true iff next() was invoked with no
// argument (i.e. the middleware passed control to the next handler).
function run(mw, req = {}) {
  let err = null;
  let called = false;
  mw(req, /* res */ {}, (e) => {
    if (e) err = e;
    else called = true;
  });
  return { req, err, called };
}

function makeReq(authorization) {
  // Express normalizes header names lower-case; mimic that.
  return { headers: authorization === undefined ? {} : { authorization } };
}

// --- requireAuth: header-shape failures -------------------------------------

test('requireAuth: missing Authorization header → 401 unauthorized', () => {
  const { err, called } = run(requireAuth, makeReq(undefined));
  assert.equal(called, false);
  assert.ok(err, 'next was called with an error');
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
  assert.equal(typeof err.message, 'string');
});

test('requireAuth: empty Authorization header → 401', () => {
  const { err, called } = run(requireAuth, makeReq(''));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: "Bearer" with no token → 401', () => {
  const { err, called } = run(requireAuth, makeReq('Bearer'));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: "Bearer " with trailing whitespace but no token → 401', () => {
  const { err, called } = run(requireAuth, makeReq('Bearer   '));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: wrong scheme ("Token foo") → 401', () => {
  const { err, called } = run(requireAuth, makeReq('Token foo'));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: lowercase "bearer" scheme is accepted (case-insensitive match)', () => {
  // Make sure we don't accidentally tighten the regex — the implementation
  // uses /^Bearer\s+(.+)$/i. Mint a real token for a real user and confirm
  // the lowercased scheme still works.
  const uid = insertUser(ctx.db, { email: 'cs@example.com', status: 'active' });
  const token = signSession({ id: uid, role: 'employee' });
  const { err, called, req } = run(requireAuth, makeReq(`bearer ${token}`));
  assert.equal(err, null, 'expected no error for valid lowercased bearer scheme');
  assert.equal(called, true);
  assert.equal(req.user.id, uid);
});

// --- requireAuth: JWT-validation failures -----------------------------------

test('requireAuth: token signed with a different secret → 401', () => {
  const bad = jwt.sign(
    { uid: 1, role: 'admin' },
    'a-different-32-char-secret-aaaaaaaa',
    { issuer: 'sred', subject: '1', expiresIn: '1h' },
  );
  const { err, called } = run(requireAuth, makeReq(`Bearer ${bad}`));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
  // The JsonWebTokenError thrown by `jwt.verify` is NOT an HttpError, so
  // the middleware's `instanceof Error && 'status' in e` guard masks it
  // and re-emits a plain `unauthorized()`. That's the desired behaviour:
  // we don't leak the JWT library's failure mode to the client.
});

test('requireAuth: expired token → 401', async () => {
  // 1ms expiry — give it a beat to actually expire before the call.
  const uid = insertUser(ctx.db, { email: 'expired@example.com', status: 'active' });
  const token = jwt.sign(
    { uid, role: 'employee' },
    config.jwtSecret,
    { issuer: 'sred', subject: String(uid), expiresIn: '1ms' },
  );
  await new Promise(r => setTimeout(r, 1100));

  const { err, called } = run(requireAuth, makeReq(`Bearer ${token}`));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: token with wrong issuer → 401', () => {
  const uid = insertUser(ctx.db, { email: 'wrongiss@example.com', status: 'active' });
  const token = jwt.sign(
    { uid, role: 'employee' },
    config.jwtSecret,
    { issuer: 'not-sred', subject: String(uid), expiresIn: '1h' },
  );
  const { err, called } = run(requireAuth, makeReq(`Bearer ${token}`));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAuth: malformed token (not even a JWT) → 401', () => {
  const { err, called } = run(requireAuth, makeReq('Bearer not-a-jwt-at-all'));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

// --- requireAuth: user-state failures ---------------------------------------

test('requireAuth: token references a user that no longer exists → 401', () => {
  // Mint a token for a real user, then delete the row.
  const uid = insertUser(ctx.db, { email: 'doomed@example.com', status: 'active' });
  const token = signSession({ id: uid, role: 'employee' });
  ctx.db.prepare(`DELETE FROM users WHERE id = ?`).run(uid);

  const { err, called } = run(requireAuth, makeReq(`Bearer ${token}`));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
  // Middleware's branch sets message to 'user not active' for both the
  // not-found and the not-active case. Pin that so a future split into
  // distinct messages is a deliberate change.
  assert.match(err.message, /user not active/);
});

test('requireAuth: token references a deactivated user (status=disabled) → 401', () => {
  const uid = insertUser(ctx.db, { email: 'disabled@example.com', status: 'disabled' });
  const token = signSession({ id: uid, role: 'employee' });

  const { err, called } = run(requireAuth, makeReq(`Bearer ${token}`));
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
  assert.match(err.message, /user not active/);
});

// --- requireAuth: happy path (unit) -----------------------------------------

test('requireAuth: valid token + active user → req.user is populated and next() runs', () => {
  const uid = insertUser(ctx.db, {
    email: 'happy@example.com',
    name: 'Happy User',
    role: 'employee',
    status: 'active',
  });
  const token = signSession({ id: uid, role: 'employee' });

  const { err, called, req } = run(requireAuth, makeReq(`Bearer ${token}`));
  assert.equal(err, null);
  assert.equal(called, true);
  assert.ok(req.user, 'req.user should be populated');
  assert.equal(req.user.id, uid);
  assert.equal(req.user.email, 'happy@example.com');
  assert.equal(req.user.name, 'Happy User');
  assert.equal(req.user.role, 'employee');
  assert.equal(req.user.status, 'active');
});

// --- requireAdmin / requireRole ---------------------------------------------

test('requireAdmin: no req.user attached (requireAuth bypassed) → 401', () => {
  const { err, called } = run(requireAdmin, {});
  assert.equal(called, false);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'unauthorized');
});

test('requireAdmin: employee role → 403 forbidden', () => {
  const req = { user: { id: 1, role: 'employee' } };
  const { err, called } = run(requireAdmin, req);
  assert.equal(called, false);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.match(err.message, /admin/);
});

test('requireAdmin: manager role → 403 (managers are not admins)', () => {
  const req = { user: { id: 2, role: 'manager' } };
  const { err, called } = run(requireAdmin, req);
  assert.equal(called, false);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
});

test('requireAdmin: admin role → next() runs', () => {
  const req = { user: { id: 3, role: 'admin' } };
  const { err, called } = run(requireAdmin, req);
  assert.equal(err, null);
  assert.equal(called, true);
});

test('requireRole(role) is a factory: requireRole("manager") admits managers, rejects employees', () => {
  const requireManager = requireRole('manager');

  const okReq = { user: { id: 4, role: 'manager' } };
  const ok = run(requireManager, okReq);
  assert.equal(ok.err, null);
  assert.equal(ok.called, true);

  const badReq = { user: { id: 5, role: 'employee' } };
  const bad = run(requireManager, badReq);
  assert.equal(bad.called, false);
  assert.equal(bad.err.status, 403);
  assert.match(bad.err.message, /manager/);
});

// --- End-to-end smoke test --------------------------------------------------
//
// Boot a stub express app with requireAuth + requireAdmin mounted on a `/test`
// route. This confirms the middleware is wired into the express request
// lifecycle correctly and that errors flow through errorMiddleware to produce
// the canonical { error: { code, message } } JSON shape.

let server;
let baseUrl;

test('e2e smoke: requireAuth + errorMiddleware emit the canonical 401 JSON shape', async () => {
  const express = (await import('express')).default;
  const { errorMiddleware } = await import('../../src/lib/errors.js');

  const adminId = insertUser(ctx.db, {
    email: 'e2e-admin@example.com', role: 'admin', status: 'active',
  });
  const employeeId = insertUser(ctx.db, {
    email: 'e2e-employee@example.com', role: 'employee', status: 'active',
  });
  const adminToken = signSession({ id: adminId, role: 'admin' });
  const employeeToken = signSession({ id: employeeId, role: 'employee' });

  const app = express();
  app.disable('x-powered-by');
  app.get('/protected', requireAuth, (req, res) =>
    res.json({ ok: true, uid: req.user.id, role: req.user.role })
  );
  app.get('/admin-only', requireAuth, requireAdmin, (_req, res) =>
    res.json({ ok: true, admin: true })
  );
  app.use(errorMiddleware);

  try {
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    // (1) No Authorization header → 401 with the canonical error envelope.
    {
      const res = await fetch(`${baseUrl}/protected`);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.ok(body.error, 'response carries an error envelope');
      assert.equal(body.error.code, 'unauthorized');
      assert.equal(typeof body.error.message, 'string');
    }

    // (2) Valid employee token, protected route → 200, req.user surfaced.
    {
      const res = await fetch(`${baseUrl}/protected`, {
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.uid, employeeId);
      assert.equal(body.role, 'employee');
    }

    // (3) Employee on an admin-only route → 403 forbidden envelope.
    {
      const res = await fetch(`${baseUrl}/admin-only`, {
        headers: { authorization: `Bearer ${employeeToken}` },
      });
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error.code, 'forbidden');
    }

    // (4) Admin on the admin-only route → 200.
    {
      const res = await fetch(`${baseUrl}/admin-only`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.admin, true);
    }
  } finally {
    if (server) await new Promise(r => server.close(r));
  }
});

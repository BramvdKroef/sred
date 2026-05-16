// Tests for the V-11 refresh-token cookie + CSRF flow on /api/auth/refresh.
//
// Strategy mirrors tests/server/rate-limit.test.js: boot a minimal express
// app with the auth router in-process, drive it with fetch(). A temp DB
// per file keeps the suite isolated; we insert refresh tokens directly via
// mintRefreshToken since the WebAuthn ceremony can't be replayed in a unit
// test.
//
// Coverage:
//   - POST /api/auth/refresh succeeds when the HttpOnly cookie is present
//     and the x-refresh-csrf header matches the double-submit cookie.
//   - The Set-Cookie response has HttpOnly + path=/api/auth/refresh on the
//     refresh cookie, and the CSRF companion is NOT HttpOnly (must be JS-
//     readable so the SPA can echo it).
//   - CSRF guard rejects (403) a request that presents the cookie but no
//     matching header.
//   - Body-only fallback still rotates (older clients pre-V-11 deploy).
//   - POST /api/logout clears both cookies with the correct path.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';

import { setupTempDb, teardownTempDb, insertUser } from '../helpers/db.js';

let ctx;
let server;
let baseUrl;
let mintRefreshToken;
let signSession;

before(async () => {
  ctx = await setupTempDb();

  const { default: api } = await import('../../src/routes/index.js');
  const { errorMiddleware } = await import('../../src/lib/errors.js');
  ({ mintRefreshToken } = await import('../../src/auth/refresh.js'));
  ({ signSession } = await import('../../src/auth/jwt.js'));

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', api);
  app.use(errorMiddleware);

  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  teardownTempDb(ctx);
});

// children-before-parents.
const DATA_TABLES = ['audit_log', 'refresh_tokens', 'users'];

beforeEach(() => {
  ctx.db.pragma('foreign_keys = OFF');
  ctx.db.exec(`DROP TRIGGER IF EXISTS audit_log_no_delete`);
  for (const table of DATA_TABLES) {
    ctx.db.exec(`DELETE FROM ${table}`);
  }
  ctx.db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
  `);
  ctx.db.pragma('foreign_keys = ON');
});

// --- helpers -----------------------------------------------------------------

// Parse a raw Set-Cookie header into a flat object keyed by cookie name.
// We don't care about Domain/SameSite parsing depth — just enough to read
// HttpOnly, Path, and value back.
function parseSetCookies(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map(line => {
    const parts = line.split('; ');
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    const name = nameVal.slice(0, eqIdx);
    const value = nameVal.slice(eqIdx + 1);
    const flags = {};
    for (const a of attrs) {
      const [k, v] = a.split('=');
      flags[k.toLowerCase()] = v === undefined ? true : v;
    }
    return { name, value, ...flags };
  });
}

function findCookie(cookies, name) {
  return cookies.find(c => c.name === name);
}

// Mint a refresh token and synthesise the cookie pair the SPA would have
// after a successful login. We don't have a real CSRF cookie value at this
// point (that's set on login); the caller fabricates one and we echo it
// in both the cookie and the header.
function loginSession(userOverrides = {}) {
  const userId = insertUser(ctx.db, userOverrides);
  const { raw } = mintRefreshToken(userId);
  return { userId, refresh: raw };
}

// --- happy path -------------------------------------------------------------

test('cookie path: refresh succeeds when both cookies + matching CSRF header are present', async () => {
  const { refresh } = loginSession();
  const csrf = 'csrf-token-12345';
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': csrf,
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=${csrf}`,
    },
    body: '{}',
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.token, 'response includes a new JWT');
  assert.ok(body.refresh_token, 'transition: body still carries the new refresh token');
});

test('cookie attributes: refresh cookie is HttpOnly + path-scoped; CSRF cookie is JS-readable', async () => {
  const { refresh } = loginSession();
  const csrf = 'matching';
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': csrf,
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=${csrf}`,
    },
    body: '{}',
  });
  assert.equal(r.status, 200);
  // node's fetch normalises set-cookie into a single getSetCookie() array.
  const setCookies = parseSetCookies(r.headers.getSetCookie());
  const refreshCookie = findCookie(setCookies, 'sred_refresh');
  const csrfCookie    = findCookie(setCookies, 'sred_refresh_csrf');
  assert.ok(refreshCookie, 'Set-Cookie includes sred_refresh');
  assert.ok(csrfCookie,    'Set-Cookie includes sred_refresh_csrf');
  assert.equal(refreshCookie.httponly, true, 'refresh cookie is HttpOnly');
  assert.equal(refreshCookie.path, '/api/auth/refresh', 'refresh cookie is path-scoped');
  assert.equal(refreshCookie.samesite?.toLowerCase?.(), 'strict');
  assert.notEqual(csrfCookie.httponly, true, 'CSRF cookie must be JS-readable');
  assert.equal(csrfCookie.path, '/api/auth/refresh');
});

// --- CSRF guard --------------------------------------------------------------

test('CSRF guard: cookie present but no x-refresh-csrf header → 403', async () => {
  const { refresh } = loginSession();
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=abc`,
    },
    body: '{}',
  });
  assert.equal(r.status, 403);
  const body = await r.json();
  assert.equal(body.error?.code, 'forbidden');
  assert.match(body.error?.message ?? '', /csrf/i);
});

test('CSRF guard: header value does not match cookie value → 403', async () => {
  const { refresh } = loginSession();
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': 'wrong-value',
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=actual-value`,
    },
    body: '{}',
  });
  assert.equal(r.status, 403);
});

test('CSRF guard: header set but CSRF cookie missing → 403', async () => {
  const { refresh } = loginSession();
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': 'orphan',
      cookie: `sred_refresh=${refresh}`,
    },
    body: '{}',
  });
  assert.equal(r.status, 403);
});

// --- body fallback ----------------------------------------------------------

test('transition: body-only refresh (no cookies) still rotates successfully', async () => {
  const { refresh } = loginSession();
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  assert.equal(r.status, 200, 'body fallback path still works during transition');
  const body = await r.json();
  assert.ok(body.token);
  assert.ok(body.refresh_token);
});

test('body fallback path also sets the cookies on the response so the client upgrades', async () => {
  const { refresh } = loginSession();
  const r = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  assert.equal(r.status, 200);
  const cookies = parseSetCookies(r.headers.getSetCookie());
  assert.ok(findCookie(cookies, 'sred_refresh'), 'rotation sets refresh cookie even on body-fallback');
  assert.ok(findCookie(cookies, 'sred_refresh_csrf'));
});

// --- logout cookie clear ----------------------------------------------------

test('POST /api/logout clears the refresh + CSRF cookies with the matching path', async () => {
  // Need an authed JWT to hit /api/logout (requireAuth). The webauthn login
  // ceremony can't be replayed, so we sign one directly.
  const { userId } = loginSession();
  const user = ctx.db.prepare(
    `SELECT id, email, name, role, status FROM users WHERE id = ?`
  ).get(userId);
  const jwt = signSession(user);

  const r = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(r.status, 200);
  const cookies = parseSetCookies(r.headers.getSetCookie());
  const cleared = findCookie(cookies, 'sred_refresh');
  const clearedCsrf = findCookie(cookies, 'sred_refresh_csrf');
  assert.ok(cleared, 'logout sets clearing Set-Cookie for sred_refresh');
  assert.ok(clearedCsrf, 'logout sets clearing Set-Cookie for sred_refresh_csrf');
  assert.equal(cleared.path, '/api/auth/refresh', 'clear must echo the original path');
  assert.equal(clearedCsrf.path, '/api/auth/refresh');
  // The clearing Set-Cookie carries an empty/expired value. Express sends
  // `Expires=Thu, 01 Jan 1970 …` so the browser deletes the cookie.
  assert.ok(
    cleared.expires || cleared['max-age'] === '0',
    'clear-cookie sets Expires in the past or Max-Age=0',
  );
});

// --- end-to-end rotation: cookie path replaces the old refresh token --------

test('cookie path consumes the presented refresh token (replay of the same value fails)', async () => {
  const { refresh } = loginSession();
  const csrf = 'x';

  // First rotation succeeds.
  const r1 = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': csrf,
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=${csrf}`,
    },
    body: '{}',
  });
  assert.equal(r1.status, 200);

  // Replay of the same refresh token → unauthorized (V-03 family revoke
  // semantics still apply: server marked the row revoked on the first call).
  const r2 = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-refresh-csrf': csrf,
      cookie: `sred_refresh=${refresh}; sred_refresh_csrf=${csrf}`,
    },
    body: '{}',
  });
  assert.equal(r2.status, 401, 'replay of consumed cookie token → 401');
});

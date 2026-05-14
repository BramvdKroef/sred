// Tests for the per-route rate limiters in src/lib/rate-limit.js.
//
// We boot the auth router in-process inside a minimal express app, then
// hammer it with supertest-style requests via node:http. The integration
// approach (rather than a pure unit test on the middleware config) exercises
// the actual express middleware chain and the JSON error shape.
//
// We don't pin a JWT/login flow here — only /api/auth/refresh, which doesn't
// require a valid session; the refresh-token validation runs *after* the
// limiter, and an invalid token returns 401. Spamming with `"x"` triggers 401
// thirty times in a row, then 429 on the 31st — which is what we assert.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { setupTempDb, teardownTempDb } from '../helpers/db.js';

let ctx;
let server;
let baseUrl;

before(async () => {
  ctx = await setupTempDb();

  // Dynamic import so DATABASE_PATH / JWT_SECRET are locked in first.
  const { default: api } = await import('../../src/routes/index.js');
  const { errorMiddleware } = await import('../../src/lib/errors.js');

  const app = express();
  app.use(express.json());
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

function post(pathname, body) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('refresh endpoint returns 429 after 30 requests in the same window', async () => {
  // First 30 requests: refresh token is invalid → 401. The limiter lets
  // them through and decrements its counter on each.
  for (let i = 0; i < 30; i++) {
    const res = await post('/api/auth/refresh', { refresh_token: 'invalid' });
    assert.equal(
      res.status, 401,
      `request ${i + 1} should be 401 unauthorized (limiter not yet engaged)`
    );
  }

  // 31st request: limiter trips.
  const tripped = await post('/api/auth/refresh', { refresh_token: 'invalid' });
  assert.equal(tripped.status, 429, 'request 31 should be rate-limited');

  const body = await tripped.json();
  assert.ok(body.error, 'response should follow {error: {...}} shape');
  assert.equal(body.error.code, 'rate_limited');
  assert.match(body.error.message, /too many/i);
});

test('rate-limit handlers return the standard error JSON shape', async () => {
  // Webauthn login/start limiter is 10/min. Burn through it and inspect
  // the 11th response.
  for (let i = 0; i < 10; i++) {
    await post('/api/webauthn/login/start', { email: `x${i}@example.com` });
  }
  const tripped = await post('/api/webauthn/login/start', { email: 'x@example.com' });
  assert.equal(tripped.status, 429);
  const body = await tripped.json();
  assert.equal(body.error.code, 'rate_limited');
});

// Tests for the Content-Security-Policy middleware in src/lib/csp.js.
//
// We exercise the middleware in isolation against a tiny express app
// (rather than booting the full server) — that keeps the test fast and
// avoids any DB/JWT setup. The thing we care about is the actual header
// value the middleware emits.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { cspMiddleware, CSP_HEADER_VALUE } from '../../src/lib/csp.js';

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(cspMiddleware);
  app.get('/', (_req, res) => res.send('ok'));
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('CSP header is set on responses', async () => {
  const res = await fetch(`${baseUrl}/`);
  const header = res.headers.get('content-security-policy');
  assert.ok(header, 'Content-Security-Policy header should be present');
  assert.equal(header, CSP_HEADER_VALUE);
});

test('CSP policy contains the directives the SPA depends on', async () => {
  const res = await fetch(`${baseUrl}/`);
  const header = res.headers.get('content-security-policy');

  // Core lockdown
  assert.match(header, /default-src 'self'/);
  assert.match(header, /object-src 'none'/);
  assert.match(header, /frame-ancestors 'none'/);
  assert.match(header, /base-uri 'self'/);
  assert.match(header, /form-action 'self'/);

  // SPA dependencies
  assert.match(header, /script-src [^;]*https:\/\/cdn\.jsdelivr\.net/);
  assert.match(header, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(header, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
  assert.match(header, /img-src [^;]*data:/);

  // No inline scripts allowed (defence vs. V-01).
  assert.doesNotMatch(header, /script-src[^;]*'unsafe-inline'/);
});

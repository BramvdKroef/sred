// Smoke test for the request-id + request-logger middleware mounted in
// src/server.js.
//
// What we assert:
//   1. Every response carries an `x-request-id` header.
//   2. The value is a fresh UUID per request when the client doesn't send one.
//   3. An inbound `x-request-id` header is echoed back (so a reverse proxy
//      / trace span survives the proxy → app boundary).
//
// We boot src/server.js in a fresh child process — same pattern as the
// shutdown / trust-proxy tests — because the module installs signal handlers
// and app.listen()s at import time, and we want a clean isolated process.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { spawnServer } from '../helpers/spawn-server.js';

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// One booted server shared by all tests in this file — the middleware under
// test is per-request, so each test gets fresh state without needing a fresh
// process. This keeps the (slow) migration boot cost off the critical path.
let serverCtx;

before(async () => {
  const port = await findFreePort();
  serverCtx = await spawnServer({ port });
});

after(async () => {
  if (serverCtx) await serverCtx.kill();
});

test('every response carries an x-request-id header', async () => {
  const res = await fetch(`${serverCtx.url}/api/health`);
  assert.equal(res.status, 200);
  const id = res.headers.get('x-request-id');
  assert.ok(id, 'response should expose an x-request-id header');
  // UUID v4 shape — fresh id (no inbound header was sent).
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test('inbound x-request-id is echoed back (proxy → app trace continuity)', async () => {
  const sentinel = 'test-trace-id-abc-123';
  const res = await fetch(`${serverCtx.url}/api/health`, {
    headers: { 'x-request-id': sentinel },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-request-id'), sentinel);
});

test('two requests get distinct request ids', async () => {
  const [a, b] = await Promise.all([
    fetch(`${serverCtx.url}/api/health`),
    fetch(`${serverCtx.url}/api/health`),
  ]);
  const idA = a.headers.get('x-request-id');
  const idB = b.headers.get('x-request-id');
  assert.ok(idA && idB);
  assert.notEqual(idA, idB, 'request ids should be unique per request');
});

test('the http_request log line is emitted on response finish', async () => {
  const res = await fetch(`${serverCtx.url}/api/health`);
  await res.text(); // drain
  // Tiny delay so the finish handler has run before we read stdout.
  await new Promise(r => setTimeout(r, 100));
  const stdout = serverCtx.getStdout();
  // The http_request line carries method, path, status, duration_ms.
  assert.match(stdout, /"msg":"http_request"/, `expected http_request log; got: ${stdout}`);
  assert.match(stdout, /"method":"GET"/);
  assert.match(stdout, /"path":"\/api\/health"/);
  assert.match(stdout, /"status":200/);
});

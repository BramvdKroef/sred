// Tests for the SIGTERM / SIGINT shutdown hook in src/server.js.
//
// Why: `systemctl restart sred` (and equivalent docker/k8s flows) send SIGTERM
// and wait for the process to exit. Without a handler, in-flight ZIP/PDF
// streams are cut mid-write and `db.close()` is never called — the WAL
// doesn't checkpoint and the next boot rolls back the open transaction.
//
// Strategy: fork the real server as a child process (so signal handling is
// installed on the *whole* process, not just a fragment), grab its ephemeral
// port from a stdout banner, then SIGTERM it. Assert:
//   1. The child exits with code 0 within 2s.
//   2. An in-flight request started before the signal completes successfully
//      (server.close lets active sockets drain instead of severing them).
//   3. A second SIGTERM after shutdown is in progress is a no-op (idempotency).
//
// Each test gets its own child because the test *is* the shutdown — once the
// signal lands the server is gone. We pay one boot per test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { spawnServer } from '../helpers/spawn-server.js';

// Reserve a free port in the parent by opening + immediately closing a
// listener; the kernel won't hand the same port to another listener for a few
// hundred ms, which is plenty for the child to grab it. This lets the test
// know the port up-front, so we don't have to parse log banners.
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

test('SIGTERM triggers graceful shutdown and exit 0 within 2s', async () => {
  const port = await findFreePort();
  const { child, exitPromise } = await spawnServer({ port });

  const tStart = Date.now();
  child.kill('SIGTERM');

  const result = await Promise.race([
    exitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown did not complete in 2s')), 2000)),
  ]);
  const elapsed = Date.now() - tStart;

  assert.equal(result.code, 0, `expected exit code 0, got ${result.code}; stderr=${result.stderr}`);
  assert.ok(elapsed < 2000, `shutdown took ${elapsed}ms (>2s)`);
  assert.match(result.stdout, /"msg":"shutdown_draining"[^}]*"signal":"SIGTERM"/);
});

test('SIGINT also triggers graceful shutdown', async () => {
  const port = await findFreePort();
  const { child, exitPromise } = await spawnServer({ port });

  child.kill('SIGINT');
  const result = await Promise.race([
    exitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown did not complete in 2s')), 2000)),
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /"msg":"shutdown_draining"[^}]*"signal":"SIGINT"/);
});

test('in-flight request started before SIGTERM completes successfully', async () => {
  const port = await findFreePort();
  const { child, url, exitPromise } = await spawnServer({ port });

  // Hit a guaranteed-public endpoint. /api/auth/refresh exists and returns
  // 401 quickly with an invalid token; that's enough to prove the socket
  // wasn't yanked mid-request. We fire the request, then SIGTERM almost
  // immediately, and assert the response still resolves.
  const reqPromise = fetch(`${url}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: 'invalid' }),
  });

  // Tiny delay so the request reaches the server before our signal lands.
  await new Promise(r => setTimeout(r, 50));
  child.kill('SIGTERM');

  const res = await reqPromise;
  assert.ok(res.status === 401 || res.status === 429,
    `expected 401 or 429 (request drained), got ${res.status}`);

  // Drain the body so the connection releases.
  await res.text();

  const result = await Promise.race([
    exitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown did not complete in 2s')), 2000)),
  ]);
  assert.equal(result.code, 0, `stderr=${result.stderr}`);
});

test('double SIGTERM is idempotent (shutdown only fires once)', async () => {
  const port = await findFreePort();
  const { child, exitPromise } = await spawnServer({ port });

  child.kill('SIGTERM');
  child.kill('SIGTERM'); // second one should be a no-op (shuttingDown guard)

  const result = await Promise.race([
    exitPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown did not complete in 2s')), 2000)),
  ]);
  assert.equal(result.code, 0);
  // Exactly one shutdown_draining line — the second SIGTERM hit the guard.
  const matches = result.stdout.match(/"msg":"shutdown_draining"/g) || [];
  assert.equal(matches.length, 1, `expected 1 draining log line, got ${matches.length}`);
});

// Tests for the unauthenticated /healthz (liveness) and /readyz (readiness)
// probes mounted in src/server.js.
//
// Why these are split:
//   /healthz is for the supervisor (systemd / k8s) — "should we restart this
//   process?". It must not touch the DB or any external dependency, or a
//   transient backend failure will trigger a restart loop that the supervisor
//   cannot solve.
//   /readyz is for the load balancer — "should we send real traffic here?".
//   It pokes the DB with `SELECT 1` so a half-broken instance (DB handle
//   closed, file unmounted) is taken out of the rotation without being
//   restarted, because a restart wouldn't fix the underlying issue.
//
// We boot src/server.js in a fresh child process — the same pattern used by
// shutdown.test.js and request-logging.test.js — because the module installs
// signal handlers and app.listen()s at import time. For the failure case we
// run a wrapper script that imports the server, waits for it to bind, then
// closes the DB handle from within the same process; subsequent /readyz hits
// see a closed handle and fail cleanly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');
const MIGRATE_PATH = path.join(REPO_ROOT, 'src', 'db', 'migrate.js');
const DB_PATH = path.join(REPO_ROOT, 'src', 'db', 'index.js');

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

// Spawn a child running `script`, with a temp DB and a deterministic port.
// Returns helpers to stop the child and to grab the buffered output. The
// caller is responsible for invoking stop() — we tear down the temp DB files
// on child exit regardless of how it ended.
function spawnChild({ script, port }) {
  const tmpDb = path.join(
    os.tmpdir(),
    `sred-health-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
  );
  const env = {
    PATH: process.env.PATH,
    DATABASE_PATH: tmpDb,
    JWT_SECRET: 'test-only-' + crypto.randomBytes(24).toString('hex'),
    ORIGIN: 'http://localhost:3000',
    PORT: String(port),
  };
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env, cwd: REPO_ROOT,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });

  const stop = () => new Promise((resolve) => {
    child.once('exit', () => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* fine */ }
      }
      resolve({ stdout, stderr });
    });
    child.kill('SIGTERM');
    // Belt-and-braces in case SIGTERM is swallowed by a stuck test wrapper.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* dead already */ } }, 3000).unref();
  });

  return { child, stop, getStdout: () => stdout, getStderr: () => stderr, tmpDb };
}

// Resolves once we see the structured "server_listening" banner — which is
// emitted by src/server.js inside its app.listen callback.
async function waitForListening(child, getStdout, getStderr, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/"msg":"server_listening"/.test(getStdout())) return;
    if (child.exitCode !== null) {
      throw new Error(
        `child exited before listening (code=${child.exitCode});\nstdout=${getStdout()}\nstderr=${getStderr()}`
      );
    }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`server never reported listening within ${timeoutMs}ms; stdout=${getStdout()}`);
}

// Standard "boot the real server" wrapper script. Runs migrations first
// (server bootstraps an empty schema otherwise) then imports the server.
function standardBootScript() {
  return `
    await import(${JSON.stringify(MIGRATE_PATH)});
    await import(${JSON.stringify(SERVER_PATH)});
  `;
}

// Boot script that, after the server is listening, force-closes the DB
// handle from the inside. This simulates the failure mode where the DB
// handle has gone bad (file unmounted, accidental close, etc.) — /readyz
// must report 503 without the process crashing.
function bootThenCloseDbScript() {
  return `
    await import(${JSON.stringify(MIGRATE_PATH)});
    const dbMod = await import(${JSON.stringify(DB_PATH)});
    await import(${JSON.stringify(SERVER_PATH)});
    // Give the listen() callback a tick to fire so the banner is on stdout
    // before we yank the DB out from under the readiness probe. Without this
    // there's a race where /readyz could be hit before the test even knows
    // the server is up.
    setTimeout(() => {
      try { dbMod.db.close(); } catch (e) { console.error('test_db_close_failed', e); }
    }, 50);
  `;
}

test('/healthz returns 200 with { ok: true } and no DB dependency', async () => {
  const port = await findFreePort();
  const ctx = spawnChild({ script: standardBootScript(), port });
  try {
    await waitForListening(ctx.child, ctx.getStdout, ctx.getStderr);

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    // Liveness probe must not be wrapped by the API router, which would
    // change the path; the response shape must be exact.
    assert.equal(res.headers.get('content-type')?.split(';')[0], 'application/json');
  } finally {
    await ctx.stop();
  }
});

test('/readyz returns 200 with { ok: true, checks: { db: "ok" } } when DB is up', async () => {
  const port = await findFreePort();
  const ctx = spawnChild({ script: standardBootScript(), port });
  try {
    await waitForListening(ctx.child, ctx.getStdout, ctx.getStderr);

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, checks: { db: 'ok' } });
  } finally {
    await ctx.stop();
  }
});

test('/readyz returns 503 with db:"fail" when the DB handle is closed', async () => {
  const port = await findFreePort();
  const ctx = spawnChild({ script: bootThenCloseDbScript(), port });
  try {
    await waitForListening(ctx.child, ctx.getStdout, ctx.getStderr);

    // The wrapper schedules db.close() at +50ms after the server is listening;
    // wait a bit longer than that so by the time we hit /readyz the handle
    // is definitely closed.
    await new Promise(r => setTimeout(r, 150));

    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(res.status, 503, `expected 503, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.checks?.db, 'fail');
    // The error string should be present and non-empty — exact wording is
    // better-sqlite3's; we don't pin it, just assert it's there for triage.
    assert.equal(typeof body.checks?.error, 'string');
    assert.ok(body.checks.error.length > 0, 'error message should be populated');

    // Critically: the process is still alive. A second probe still answers,
    // it doesn't 500 the connection or crash the event loop.
    const res2 = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res2.status, 200, '/healthz should still respond after DB failure');
    assert.deepEqual(await res2.json(), { ok: true });
  } finally {
    await ctx.stop();
  }
});

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
import net from 'node:net';
import path from 'node:path';

import { spawnServer } from '../helpers/spawn-server.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
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

// Extra-script tail for the failure case: after the server is listening,
// force-close the DB handle from the inside. This simulates the failure mode
// where the DB handle has gone bad (file unmounted, accidental close, etc.) —
// /readyz must report 503 without the process crashing. The 50ms timer gives
// the listen() callback a tick to fire so the banner is on stdout before we
// yank the DB out from under the readiness probe.
const closeDbExtraScript = `
  const dbMod = await import(${JSON.stringify(DB_PATH)});
  setTimeout(() => {
    try { dbMod.db.close(); } catch (e) { console.error('test_db_close_failed', e); }
  }, 50);
`;

test('/healthz returns 200 with { ok: true } and no DB dependency', async () => {
  const port = await findFreePort();
  const ctx = await spawnServer({ port });
  try {
    const res = await fetch(`${ctx.url}/healthz`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true });

    // Liveness probe must not be wrapped by the API router, which would
    // change the path; the response shape must be exact.
    assert.equal(res.headers.get('content-type')?.split(';')[0], 'application/json');
  } finally {
    await ctx.kill();
  }
});

test('/readyz returns 200 with { ok: true, checks: { db: "ok" } } when DB is up', async () => {
  const port = await findFreePort();
  const ctx = await spawnServer({ port });
  try {
    const res = await fetch(`${ctx.url}/readyz`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, checks: { db: 'ok' } });
  } finally {
    await ctx.kill();
  }
});

test('/readyz returns 503 with db:"fail" when the DB handle is closed', async () => {
  const port = await findFreePort();
  const ctx = await spawnServer({ port, extraScript: closeDbExtraScript });
  try {
    // The wrapper schedules db.close() at +50ms after the server is listening;
    // wait a bit longer than that so by the time we hit /readyz the handle
    // is definitely closed.
    await new Promise(r => setTimeout(r, 150));

    const res = await fetch(`${ctx.url}/readyz`);
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
    const res2 = await fetch(`${ctx.url}/healthz`);
    assert.equal(res2.status, 200, '/healthz should still respond after DB failure');
    assert.deepEqual(await res2.json(), { ok: true });
  } finally {
    await ctx.kill();
  }
});

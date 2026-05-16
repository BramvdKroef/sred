// Shared helper for tests that need to boot src/server.js as a child process.
//
// Why this exists: src/server.js calls `app.listen()` and installs SIGTERM /
// SIGINT handlers at import time. Tests that exercise those side-effects
// (shutdown semantics, request-id middleware, /healthz, trust-proxy wiring)
// can't import server.js in-process — they need a fresh child. Multiple test
// files previously hand-rolled this dance with subtle inconsistencies; in
// particular each file picked a 4s readiness timeout that started tripping
// once we accumulated 16 migrations (boot can exceed 4s on slow CI / first
// run after a `node --test` warm-up). The flake surfaces as:
//   `server never reported listening; stdout=<wall of migration logs>`
//
// This helper centralises the spawn + wait + cleanup logic with a generous
// 20s readiness timeout default. Fast tests still resolve in <2s — the
// timeout only matters when migrations run slowly.
//
// Usage:
//   import { spawnServer } from '../helpers/spawn-server.js';
//   const { url, child, kill, getStdout, getStderr, exitPromise } =
//     await spawnServer({ env: { PORT: String(port) } });
//   ...
//   await kill();

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');
const MIGRATE_PATH = path.join(REPO_ROOT, 'src', 'db', 'migrate.js');

// The structured boot line that src/server.js emits inside the app.listen
// callback. Matching on the JSON `msg` field is more robust than parsing the
// human-readable banner.
const LISTENING_PATTERN = /"msg":"server_listening"/;

/**
 * Spawn src/server.js in a fresh child process with a temp SQLite DB.
 *
 * @param {object} options
 * @param {object} [options.env]           Extra env vars merged on top of the
 *                                          inherited PATH and the auto-injected
 *                                          DATABASE_PATH / JWT_SECRET / ORIGIN.
 * @param {string|number} [options.port]   PORT to pass to the child. Default '0'
 *                                          (ephemeral). If you need to know the
 *                                          port up-front, pass one reserved via
 *                                          a parent-side findFreePort().
 * @param {number} [options.readyTimeoutMs] How long to wait for the
 *                                          "server_listening" log line before
 *                                          giving up. Default 20000ms — 16
 *                                          migrations + slow CI is the common
 *                                          failure mode at lower values.
 * @param {string} [options.extraScript]   JS to run *after* the server has
 *                                          been imported (eg. forcibly close
 *                                          the DB to simulate a bad handle).
 *                                          Useful for the health/readyz tests.
 * @param {boolean} [options.awaitListening=true]
 *                                          When false, resolve as soon as the
 *                                          child is spawned without waiting
 *                                          for the "server_listening" log
 *                                          line. Used by tests that drive
 *                                          their own probe via `extraScript`
 *                                          and don't actually fetch over HTTP
 *                                          (eg. trust-proxy.test.js prints a
 *                                          sentinel and exits before listen
 *                                          flushes — there's no banner to
 *                                          wait on, only an exit code).
 * @returns {Promise<{
 *   url: string,
 *   child: import('child_process').ChildProcess,
 *   kill: () => Promise<{ stdout: string, stderr: string }>,
 *   getStdout: () => string,
 *   getStderr: () => string,
 *   exitPromise: Promise<{ code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string }>,
 *   dbPath: string,
 * }>}
 */
export async function spawnServer(options = {}) {
  const {
    env: extraEnv = {},
    port,
    readyTimeoutMs = 20000,
    extraScript = '',
    awaitListening = true,
  } = options;

  const tmpDb = path.join(
    os.tmpdir(),
    `sred-spawn-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`
  );

  // Always run migrations before importing the server — server.js doesn't
  // bootstrap a schema, so any incidental query path will crash without this.
  const script = `
    await import(${JSON.stringify(MIGRATE_PATH)});
    await import(${JSON.stringify(SERVER_PATH)});
    ${extraScript}
  `;

  const env = {
    PATH: process.env.PATH,
    DATABASE_PATH: tmpDb,
    // config.js requires JWT_SECRET (>=32 chars, non-weak) at module load.
    JWT_SECRET: 'test-only-' + crypto.randomBytes(24).toString('hex'),
    ORIGIN: 'http://localhost:3000',
    PORT: port !== undefined ? String(port) : '0',
    ...extraEnv,
  };

  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env,
    cwd: REPO_ROOT,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  // Track exit so kill() can await full teardown (incl. DB cleanup).
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* fine */ }
      }
      resolve({ code, signal, stdout, stderr });
    });
  });

  // Wait for either the "listening" log line, an early exit, or the timeout.
  // We poll on 25ms — that's tight enough to keep happy-path latency low and
  // loose enough to not burn CPU on a slow boot. Skipped for callers that
  // don't actually want to make HTTP requests (see awaitListening above).
  if (awaitListening) {
    await waitForListening(child, () => stdout, () => stderr, readyTimeoutMs);
  }

  // Resolve the bound URL. If the caller passed a port, use that; otherwise
  // pluck the port from the JSON banner (which always carries the actual
  // bound port, including when PORT=0). The banner shape from src/server.js
  // is: {"msg":"server_listening","port":NNNN, ...}
  let url;
  if (port !== undefined && String(port) !== '0') {
    url = `http://127.0.0.1:${port}`;
  } else if (awaitListening) {
    const portMatch = stdout.match(/"msg":"server_listening"[^}]*"port":(\d+)/);
    if (portMatch) {
      url = `http://127.0.0.1:${portMatch[1]}`;
    } else {
      // Banner present but no port — shouldn't happen, but don't crash.
      url = null;
    }
  } else {
    // Caller opted out of waiting for the banner; they're expected to figure
    // out the URL on their own (eg. trust-proxy.test.js doesn't make HTTP
    // requests, only inspects app config).
    url = null;
  }

  const kill = () => new Promise((resolve) => {
    if (child.exitCode !== null) {
      // Already exited — just resolve with the captured output.
      resolve({ stdout, stderr });
      return;
    }
    child.once('exit', () => resolve({ stdout, stderr }));
    child.kill('SIGTERM');
    // Belt-and-braces: if SIGTERM is swallowed (eg. a wedged migration loop),
    // hammer with SIGKILL after 3s so the test runner doesn't hang forever.
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* dead already */ }
    }, 3000).unref();
  });

  return {
    url,
    child,
    kill,
    getStdout: () => stdout,
    getStderr: () => stderr,
    exitPromise,
    dbPath: tmpDb,
  };
}

async function waitForListening(child, getStdout, getStderr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (LISTENING_PATTERN.test(getStdout())) return;
    if (child.exitCode !== null) {
      throw new Error(
        `child exited before listening (code=${child.exitCode});\n` +
        `stdout=${getStdout()}\nstderr=${getStderr()}`
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  // Timeout. Kill the child so it doesn't linger, then report what we saw.
  try { child.kill('SIGKILL'); } catch { /* fine */ }
  throw new Error(
    `server never reported listening within ${timeoutMs}ms;\n` +
    `stdout=${getStdout()}\nstderr=${getStderr()}`
  );
}

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

async function bootServer({ port }) {
  const tmpDb = path.join(
    os.tmpdir(),
    `sred-reqlog-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
  );
  const script = `
    await import(${JSON.stringify(path.join(REPO_ROOT, 'src', 'db', 'migrate.js'))});
    await import(${JSON.stringify(SERVER_PATH)});
  `;
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

  // Wait for the structured boot line that the new logger emits.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (/"msg":"server_listening"/.test(stdout)) break;
    if (child.exitCode !== null) {
      throw new Error(`child exited before listening; stdout=${stdout}\nstderr=${stderr}`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
  if (!/"msg":"server_listening"/.test(stdout)) {
    child.kill('SIGKILL');
    throw new Error(`server never reported listening; stdout=${stdout}`);
  }

  const stop = () => new Promise((resolve) => {
    child.once('exit', () => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* fine */ }
      }
      resolve({ stdout, stderr });
    });
    child.kill('SIGTERM');
  });
  return { child, stop, getStdout: () => stdout, getStderr: () => stderr };
}

test('every response carries an x-request-id header', async () => {
  const port = await findFreePort();
  const { stop } = await bootServer({ port });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    const id = res.headers.get('x-request-id');
    assert.ok(id, 'response should expose an x-request-id header');
    // UUID v4 shape — fresh id (no inbound header was sent).
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  } finally {
    await stop();
  }
});

test('inbound x-request-id is echoed back (proxy → app trace continuity)', async () => {
  const port = await findFreePort();
  const { stop } = await bootServer({ port });
  try {
    const sentinel = 'test-trace-id-abc-123';
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'x-request-id': sentinel },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), sentinel);
  } finally {
    await stop();
  }
});

test('two requests get distinct request ids', async () => {
  const port = await findFreePort();
  const { stop } = await bootServer({ port });
  try {
    const [a, b] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/health`),
      fetch(`http://127.0.0.1:${port}/api/health`),
    ]);
    const idA = a.headers.get('x-request-id');
    const idB = b.headers.get('x-request-id');
    assert.ok(idA && idB);
    assert.notEqual(idA, idB, 'request ids should be unique per request');
  } finally {
    await stop();
  }
});

test('the http_request log line is emitted on response finish', async () => {
  const port = await findFreePort();
  const { stop, getStdout } = await bootServer({ port });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    await res.text(); // drain
    // Tiny delay so the finish handler has run before we read stdout.
    await new Promise(r => setTimeout(r, 100));
    const stdout = getStdout();
    // The http_request line carries method, path, status, duration_ms.
    assert.match(stdout, /"msg":"http_request"/, `expected http_request log; got: ${stdout}`);
    assert.match(stdout, /"method":"GET"/);
    assert.match(stdout, /"path":"\/api\/health"/);
    assert.match(stdout, /"status":200/);
  } finally {
    await stop();
  }
});

// Tests for the `trust proxy` express setting wired up in src/server.js.
//
// Why: without `app.set('trust proxy', ...)`, behind any reverse proxy
// (nginx/Caddy/Cloudflare) `req.ip` collapses to the proxy's loopback. Every
// IP-keyed rate limiter then shares one bucket — V-04 effectively void.
//
// We boot src/server.js as a child process with TRUST_PROXY set, then have
// that process print its `app.get('trust proxy')` value to stdout as JSON and
// exit. The child pattern is needed because src/server.js calls app.listen()
// and installs process-level signal handlers at import time; one fresh
// process per scenario keeps tests hermetic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');

function probeTrustProxy({ trustProxy }) {
  const tmpDb = path.join(
    os.tmpdir(),
    `sred-trustproxy-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`
  );

  // Inline driver:
  //   - Run migrate first (server.js imports db/index.js; the schema needs to
  //     exist so any incidental query path stays sane).
  //   - Import server.js — this calls app.listen on an ephemeral port.
  //   - Print the trust-proxy setting.
  //   - server.close(), db.close(), exit 0.
  const script = `
    await import(${JSON.stringify(path.join(REPO_ROOT, 'src', 'db', 'migrate.js'))});
    const { app, server } = await import(${JSON.stringify(SERVER_PATH)});
    const { db } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src', 'db', 'index.js'))});
    // Unique sentinel + JSON on its own line so the test can pluck it out of
    // migration stdout noise.
    process.stdout.write('\\n__PROBE__' + JSON.stringify({ trustProxy: app.get('trust proxy') }) + '__END__\\n');
    await new Promise(r => server.close(r));
    try { db.close(); } catch {}
    process.exit(0);
  `;

  return new Promise((resolve, reject) => {
    const env = {
      PATH: process.env.PATH,
      DATABASE_PATH: tmpDb,
      JWT_SECRET: 'test-only-' + crypto.randomBytes(24).toString('hex'),
      ORIGIN: 'http://localhost:3000',
      // Random unused port so concurrent runs don't collide.
      PORT: '0',
    };
    if (trustProxy !== undefined) env.TRUST_PROXY = String(trustProxy);

    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env, cwd: REPO_ROOT,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => {
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tmpDb + suffix); } catch { /* fine */ }
      }
      if (code !== 0) {
        return reject(new Error(`child exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      }
      const m = stdout.match(/__PROBE__(.*?)__END__/);
      if (!m) {
        return reject(new Error(`probe sentinel not found in stdout: ${stdout}\nstderr: ${stderr}`));
      }
      try { resolve(JSON.parse(m[1])); }
      catch { reject(new Error(`bad probe JSON: ${m[1]}\nstderr: ${stderr}`)); }
    });
  });
}

test('app honours TRUST_PROXY env var (default 1)', async () => {
  const { trustProxy } = await probeTrustProxy({ trustProxy: undefined });
  assert.equal(typeof trustProxy, 'number', `expected numeric trust proxy, got ${typeof trustProxy}`);
  assert.equal(trustProxy, 1, 'default TRUST_PROXY must be 1 (single nginx/Caddy hop)');
});

test('TRUST_PROXY=0 disables proxy trust (bare-metal mode)', async () => {
  const { trustProxy } = await probeTrustProxy({ trustProxy: 0 });
  assert.equal(trustProxy, 0);
});

test('TRUST_PROXY=2 supports nested proxy deployments', async () => {
  const { trustProxy } = await probeTrustProxy({ trustProxy: 2 });
  assert.equal(trustProxy, 2);
});

// Tests for the `trust proxy` express setting wired up in src/server.js.
//
// Why: without `app.set('trust proxy', ...)`, behind any reverse proxy
// (nginx/Caddy/Cloudflare) `req.ip` collapses to the proxy's loopback. Every
// IP-keyed rate limiter then shares one bucket — V-04 effectively void.
//
// We boot src/server.js as a child process with TRUST_PROXY set via the
// shared spawnServer helper, then use the helper's `extraScript` hook to
// print `app.get('trust proxy')` and exit. Once the helper resolves we know
// the server is listening; the probe sentinel arrives shortly after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { spawnServer } from '../helpers/spawn-server.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SERVER_PATH = path.join(REPO_ROOT, 'src', 'server.js');
const DB_INDEX_PATH = path.join(REPO_ROOT, 'src', 'db', 'index.js');

async function probeTrustProxy({ trustProxy }) {
  // Extra script runs after server.js has been imported. We re-import to get
  // a handle on `app`/`server`, print a unique sentinel + JSON on its own
  // line so the test can pluck it out of stdout noise, then cleanly shut
  // down and exit.
  //
  // We don't need to wait for `app.listen()`'s callback (and hence the
  // "server_listening" log line) — the trust-proxy setting is fixed at
  // import time, before listen even fires. That's why we set
  // `awaitListening: false` below: the original test relied on the child
  // exit, not the listening banner, and that's still the right contract.
  const extraScript = `
    const srvMod = await import(${JSON.stringify(SERVER_PATH)});
    const dbMod = await import(${JSON.stringify(DB_INDEX_PATH)});
    process.stdout.write('\\n__PROBE__' + JSON.stringify({ trustProxy: srvMod.app.get('trust proxy') }) + '__END__\\n');
    await new Promise(r => srvMod.server.close(r));
    try { dbMod.db.close(); } catch {}
    process.exit(0);
  `;

  const env = {};
  if (trustProxy !== undefined) env.TRUST_PROXY = String(trustProxy);

  const ctx = await spawnServer({ env, extraScript, awaitListening: false });

  // Wait for the child to print the sentinel and exit cleanly.
  const { code, stdout, stderr } = await ctx.exitPromise;
  if (code !== 0) {
    throw new Error(`child exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  const m = stdout.match(/__PROBE__(.*?)__END__/);
  if (!m) {
    throw new Error(`probe sentinel not found in stdout: ${stdout}\nstderr: ${stderr}`);
  }
  try { return JSON.parse(m[1]); }
  catch { throw new Error(`bad probe JSON: ${m[1]}\nstderr: ${stderr}`); }
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

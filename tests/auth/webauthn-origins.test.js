// Tests for src/config.js -> config.origins (V-07 hardening).
//
// config.origins is parsed from process.env.ORIGIN as a comma-separated list.
//   - Single value still works (1-element array).
//   - Multi-value entries are trimmed.
//   - In production (NODE_ENV === 'production') every entry must be https://.
//
// config.js memoises its export via the ES-module cache, so each test that
// flips env must run config.js in a *fresh* module graph. We do that by
// spawning a child Node process; this keeps the test hermetic and avoids
// touching the parent's already-loaded config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

// Path resolution: this test file lives at tests/auth/, src/ is two up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'src', 'config.js');

// Tiny helper: run a one-shot Node process that imports config.js under a
// specific env and prints JSON to stdout. Returns { status, stdout, stderr }.
function runWithEnv(env, script) {
  const fullEnv = {
    // Inherit PATH so node-modules resolution works, but blank out anything
    // we want to control explicitly.
    PATH: process.env.PATH,
    // Always provide a valid JWT_SECRET so config.js doesn't blow up on the
    // unrelated jwtSecret() guard.
    JWT_SECRET: 'test-only-' + crypto.randomBytes(24).toString('hex'),
    ...env,
  };
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: fullEnv,
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
}

test('config.origins parses a single ORIGIN value into a 1-element array', () => {
  const script = `
    import { config } from ${JSON.stringify(CONFIG_PATH)};
    process.stdout.write(JSON.stringify(config.origins));
  `;
  const r = runWithEnv({ ORIGIN: 'http://localhost:3000' }, script);
  assert.equal(r.status, 0, `child exited non-zero: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, ['http://localhost:3000']);
});

test('config.origins parses a comma-separated ORIGIN into N trimmed elements', () => {
  const script = `
    import { config } from ${JSON.stringify(CONFIG_PATH)};
    process.stdout.write(JSON.stringify(config.origins));
  `;
  // Mixed whitespace and an empty segment to exercise trim+filter.
  const r = runWithEnv(
    { ORIGIN: 'https://a.example.com,  https://b.example.com , https://c.example.com,' },
    script
  );
  assert.equal(r.status, 0, `child exited non-zero: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.deepEqual(parsed, [
    'https://a.example.com',
    'https://b.example.com',
    'https://c.example.com',
  ]);
});

test('config.js throws at import time when NODE_ENV=production and ORIGIN is not https', () => {
  const script = `
    try {
      await import(${JSON.stringify(CONFIG_PATH)});
      process.exit(0); // unexpected success
    } catch (err) {
      process.stderr.write(err.message);
      process.exit(7); // sentinel
    }
  `;
  const r = runWithEnv(
    { NODE_ENV: 'production', ORIGIN: 'http://insecure.example.com' },
    script
  );
  assert.equal(r.status, 7, `expected sentinel exit 7, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /https:\/\/ in production/);
});

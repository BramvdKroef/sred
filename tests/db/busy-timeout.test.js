// Verifies that `busy_timeout` is honoured: a second writer contending for
// the same DB file should block briefly rather than immediately raising
// SQLITE_BUSY. Two acceptable outcomes when the contended lock is released
// within the budget:
//   (a) the second write waits and then succeeds, OR
//   (b) the second write throws SQLITE_BUSY only after waiting roughly the
//       full busy_timeout (lock outlived the budget).
//
// What we explicitly want to *fail*: an instant (≪ busy_timeout) SQLITE_BUSY.
// That's the symptom users would see as a sporadic 500. See RELIABILITY_REVIEW
// item D-1.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const TIMEOUT_MS = 5000;       // matches src/db/index.js busy_timeout
const HOLD_MS = 250;           // first writer holds the lock briefly
const FAST_FAIL_THRESHOLD = 50; // anything under this is "instant" — bug

let dbPath;
let writerA;
let writerB;

before(() => {
  dbPath = path.join(
    os.tmpdir(),
    `sred-busy-${process.pid}-${crypto.randomBytes(6).toString('hex')}.db`,
  );

  // Bootstrap a tiny schema. Use one connection just for setup so the test
  // connections start clean.
  const setup = new Database(dbPath);
  setup.pragma('journal_mode = WAL');
  setup.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  setup.close();

  // Two independent connections to the same file, configured the same way
  // src/db/index.js configures the production connection.
  writerA = new Database(dbPath);
  writerA.pragma('journal_mode = WAL');
  writerA.pragma('foreign_keys = ON');
  writerA.pragma(`busy_timeout = ${TIMEOUT_MS}`);

  writerB = new Database(dbPath);
  writerB.pragma('journal_mode = WAL');
  writerB.pragma('foreign_keys = ON');
  writerB.pragma(`busy_timeout = ${TIMEOUT_MS}`);
});

after(() => {
  try { writerA?.close(); } catch { /* ignore */ }
  try { writerB?.close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* missing is fine */ }
  }
});

test('busy_timeout pragma is set to 5000 ms on production connection', async () => {
  // Sanity-check the production module so this test fails loudly if anyone
  // removes the pragma from src/db/index.js.
  process.env.DATABASE_PATH = dbPath;
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'test-only-' + crypto.randomBytes(24).toString('hex');
  }
  const { db } = await import('../../src/db/index.js');
  const value = db.pragma('busy_timeout', { simple: true });
  assert.equal(Number(value), TIMEOUT_MS);
});

test('second writer waits (does not instantly throw SQLITE_BUSY) when first holds the write lock', async () => {
  // Begin an IMMEDIATE transaction on A — this takes the write lock right
  // away under WAL, so B's next write will contend.
  writerA.exec('BEGIN IMMEDIATE');
  writerA.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('a', '1');

  // Release the lock after HOLD_MS via a real timer (not blocking — the C
  // call inside writerB is what blocks the event loop, but Node timers
  // queued before that call still fire on schedule once the C call returns
  // or the timer wheel is serviced). We schedule on a separate tick by
  // using setImmediate so the timer is armed before writerB starts.
  let released = false;
  const releaseTimer = setTimeout(() => {
    try {
      writerA.exec('COMMIT');
      released = true;
    } catch { /* ignore */ }
  }, HOLD_MS);
  // Don't keep the process alive on this timer if something goes wrong.
  releaseTimer.unref?.();

  // Yield once so the timer is registered before the synchronous write call.
  await new Promise((resolve) => setImmediate(resolve));

  const start = Date.now();
  let threw = null;
  try {
    writerB.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('b', '2');
  } catch (err) {
    threw = err;
  }
  const elapsed = Date.now() - start;

  // Clean up just in case.
  clearTimeout(releaseTimer);
  if (!released) {
    try { writerA.exec('COMMIT'); } catch { /* ignore */ }
  }

  if (threw) {
    // If it threw, it must be SQLITE_BUSY *and* it must have waited roughly
    // the full timeout — anything shorter means busy_timeout isn't working.
    assert.match(
      String(threw.code ?? threw.message),
      /SQLITE_BUSY/,
      `unexpected error: ${threw.message}`,
    );
    assert.ok(
      elapsed >= TIMEOUT_MS - 500,
      `SQLITE_BUSY thrown after only ${elapsed}ms — busy_timeout not honoured`,
    );
  } else {
    // Happy path: the write succeeded after waiting at least until the
    // first writer released the lock. It must NOT have completed instantly.
    assert.ok(
      elapsed >= FAST_FAIL_THRESHOLD,
      `second write completed in ${elapsed}ms — suspiciously fast, expected to wait for lock`,
    );
    const row = writerB.prepare('SELECT v FROM kv WHERE k = ?').get('b');
    assert.equal(row?.v, '2');
  }
});

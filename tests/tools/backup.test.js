// Smoke-test tools/backup.js.
//
// Runs the backup script against a temp DB (set via DATABASE_PATH) and asserts:
//   - the backup file lands under data/backups/ with a YYYY-MM-DDTHH-MM-SS.db name
//   - the backup file opens with better-sqlite3
//   - row counts in the backup match the source
//   - BACKUP_RETENTION_DAYS prunes older snapshots
//
// We invoke the script as a child process so we exercise the same code path
// an operator's `npm run backup` would hit. process.env is forwarded so the
// child inherits DATABASE_PATH / JWT_SECRET / BACKUP_RETENTION_DAYS overrides.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { setupTempDb, teardownTempDb, insertUser, insertClaimant } from '../helpers/db.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const BACKUP_SCRIPT = path.join(REPO_ROOT, 'tools', 'backup.js');

let ctx;
let scratchRoot;
let scratchBackupsDir;

before(async () => {
  ctx = await setupTempDb();

  // Seed a couple of rows we can later count against to confirm the backup
  // is a real snapshot of the source, not an empty file.
  insertUser(ctx.db, { email: `backup-${crypto.randomBytes(3).toString('hex')}@x.test` });
  insertUser(ctx.db, { email: `backup-${crypto.randomBytes(3).toString('hex')}@x.test` });
  insertClaimant(ctx.db);

  // The backup script writes to <ROOT_DIR>/data/backups. ROOT_DIR is derived
  // from src/config.js's import.meta.url, which resolves to the real repo
  // root. Rather than try to redirect it, we run the script and then read
  // back from the canonical location, but we DO clean up our own writes so
  // we don't leave noise behind on the developer's checkout.
  scratchRoot = path.join(REPO_ROOT, 'data', 'backups');
  scratchBackupsDir = scratchRoot;
});

after(() => {
  teardownTempDb(ctx);
});

function listBackupFiles() {
  if (!fs.existsSync(scratchBackupsDir)) return [];
  return fs.readdirSync(scratchBackupsDir).filter(n => n.endsWith('.db'));
}

function runBackup(extraEnv = {}) {
  return spawnSync(process.execPath, [BACKUP_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  });
}

test('npm run backup produces a usable .db snapshot with matching row counts', () => {
  const before = new Set(listBackupFiles());
  const result = runBackup();
  assert.equal(result.status, 0, `backup script failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /db backup\s+->/);

  const after = listBackupFiles();
  const fresh = after.filter(n => !before.has(n));
  assert.ok(fresh.length >= 1, 'a new .db snapshot should have appeared');
  const newest = fresh
    .map(n => ({ name: n, m: fs.statSync(path.join(scratchBackupsDir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0].name;

  assert.match(newest, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$/);

  // Open the backup with better-sqlite3 and confirm it matches the source.
  const backupPath = path.join(scratchBackupsDir, newest);
  const userCountSource = ctx.db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
  const claimantCountSource = ctx.db.prepare(`SELECT COUNT(*) AS n FROM claimants`).get().n;

  const snap = new Database(backupPath, { readonly: true });
  try {
    const userCount = snap.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
    const claimantCount = snap.prepare(`SELECT COUNT(*) AS n FROM claimants`).get().n;
    assert.equal(userCount, userCountSource);
    assert.equal(claimantCount, claimantCountSource);
  } finally {
    snap.close();
  }

  // Cleanup: remove the file we just created so we don't leave artifacts
  // behind on the developer's working tree.
  fs.unlinkSync(backupPath);
});

test('BACKUP_RETENTION_DAYS=0 prunes pre-existing snapshots', () => {
  // Drop a synthetic "old" snapshot into the backups dir, then run the script
  // with retention=0 and assert it disappears.
  fs.mkdirSync(scratchBackupsDir, { recursive: true });
  const stale = path.join(scratchBackupsDir, '2020-01-01T00-00-00.db');
  fs.writeFileSync(stale, '');
  // Force mtime backward so the cutoff sweeps it even when retention is high.
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(stale, past, past);

  const result = runBackup({ BACKUP_RETENTION_DAYS: '0' });
  assert.equal(result.status, 0, `backup script failed: ${result.stderr || result.stdout}`);
  assert.ok(!fs.existsSync(stale), 'stale snapshot should have been pruned');

  // Clean up: the script also wrote a fresh snapshot; remove it.
  for (const name of listBackupFiles()) {
    if (name === '2020-01-01T00-00-00.db') continue;
    const full = path.join(scratchBackupsDir, name);
    // Only delete files we created during this test run (mtime within the
    // last 5 minutes) — protects any real developer backups in the dir.
    if (Date.now() - fs.statSync(full).mtimeMs < 5 * 60_000) {
      fs.unlinkSync(full);
    }
  }
});

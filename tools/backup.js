#!/usr/bin/env node
//
// tools/backup.js — online backup of the SQLite database (and optionally the
// uploads directory). Safe to run while the server is up: better-sqlite3's
// db.backup() uses the SQLite online-backup API which cooperates with WAL.
//
// Usage:
//   node tools/backup.js
//   npm run backup
//
// Outputs:
//   data/backups/<YYYY-MM-DDTHH-MM-SS>.db
//   data/backups/uploads-<YYYY-MM-DDTHH-MM-SS>.tar.gz   (if uploads/ is non-empty)
//
// Retention:
//   Old backups are pruned via BACKUP_RETENTION_DAYS (default 30). Both the
//   .db snapshots and the matching uploads tarballs are subject to the same
//   retention window — they're paired by timestamp.
//
// Notes:
//   - data/bundles/*.zip is intentionally NOT backed up. T661 export rows
//     in the DB carry enough metadata to rebuild any bundle on demand.
//   - The uploads tarball uses node:zlib + a child tar process so we don't
//     pull in a new npm dependency. If `tar` is unavailable, the script
//     warns and skips the tarball (the DB snapshot still completes).

import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { config, ROOT_DIR } from '../src/config.js';

const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 30);

function timestamp() {
  // ISO-ish, filesystem-safe (no colons). 2026-05-14T15-32-08
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

async function backupDatabase(backupsDir, stamp) {
  const dest = path.join(backupsDir, `${stamp}.db`);
  if (!fs.existsSync(config.databasePath)) {
    throw new Error(`source DB not found: ${config.databasePath}`);
  }
  const db = new Database(config.databasePath, { readonly: true });
  try {
    // better-sqlite3 returns a Promise from .backup(). The online-backup API
    // cooperates with WAL — a concurrent writer is fine.
    await db.backup(dest);
  } finally {
    db.close();
  }
  return dest;
}

function backupUploads(backupsDir, stamp) {
  const uploadsDir = config.uploadsDir;
  if (!fs.existsSync(uploadsDir)) return null;
  const entries = fs.readdirSync(uploadsDir);
  if (entries.length === 0) return null;

  const dest = path.join(backupsDir, `uploads-${stamp}.tar.gz`);
  // Shell out to `tar` (BSD/GNU). This is dev-script territory — no need to
  // hand-roll a tar implementation. `tar` is part of every supported OS.
  const result = spawnSync(
    'tar',
    [
      '-czf', dest,
      '-C', path.dirname(uploadsDir),
      path.basename(uploadsDir),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (result.error || result.status !== 0) {
    console.warn(
      `warn: uploads tar failed (${result.error?.message ?? `exit ${result.status}`}); ` +
      `DB snapshot still completed`
    );
    try { fs.unlinkSync(dest); } catch { /* file may not exist */ }
    return null;
  }
  return dest;
}

function pruneOldBackups(backupsDir, retentionDays) {
  const cutoffMs = Date.now() - retentionDays * 86_400_000;
  let removed = 0;
  for (const name of fs.readdirSync(backupsDir)) {
    if (!name.endsWith('.db') && !name.endsWith('.tar.gz')) continue;
    const full = path.join(backupsDir, name);
    let stat;
    try { stat = fs.statSync(full); }
    catch { continue; }
    if (stat.mtimeMs < cutoffMs) {
      try {
        fs.unlinkSync(full);
        removed += 1;
      } catch (e) {
        console.warn(`warn: could not prune ${full}: ${e.message}`);
      }
    }
  }
  return removed;
}

async function main() {
  const backupsDir = path.resolve(ROOT_DIR, 'data', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const stamp = timestamp();
  const dbPath = await backupDatabase(backupsDir, stamp);
  console.log(`db backup    -> ${dbPath}`);

  const uploadsPath = backupUploads(backupsDir, stamp);
  if (uploadsPath) {
    console.log(`uploads tar  -> ${uploadsPath}`);
  } else {
    console.log('uploads tar  -> (skipped: empty or unavailable)');
  }

  const removed = pruneOldBackups(backupsDir, RETENTION_DAYS);
  if (removed > 0) {
    console.log(`pruned ${removed} file(s) older than ${RETENTION_DAYS} days`);
  }
}

main().catch(err => {
  console.error(`backup failed: ${err.stack || err.message}`);
  process.exit(1);
});

// SQLite connection bootstrap.
//
// Pragmas:
//   journal_mode = WAL
//     Permits concurrent readers alongside a single writer. Required so that
//     long-running read queries don't block mutating routes.
//
//   foreign_keys = ON
//     SQLite ships with FK enforcement off by default; we want it on so the
//     schema's referential constraints actually apply at runtime.
//
//   busy_timeout = 5000
//     Implicit retry budget for SQLITE_BUSY. better-sqlite3 is synchronous,
//     so under WAL the only realistic contention is two writers racing (e.g.
//     a checkpoint mid-transaction, or two server processes hitting the same
//     file). With this pragma set, any statement that would otherwise raise
//     SQLITE_BUSY will instead block in the SQLite C layer for up to 5
//     seconds waiting for the lock, then throw if the lock is still held.
//     This makes the retry transparent to route handlers — they do not need
//     their own retry wrapper for the common contention case. See
//     RELIABILITY_REVIEW.md item D-1.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

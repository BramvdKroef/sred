import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const applied = new Set(db.prepare('SELECT filename FROM _migrations').all().map(r => r.filename));
const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Disable FK enforcement for the duration of each migration so table
  // recreates (the SQLite-recommended way to alter a CHECK constraint)
  // don't trip on inbound references. PRAGMA inside a transaction is a
  // no-op, so we toggle outside.
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  });
  tx();
  db.pragma('foreign_keys = ON');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) {
    console.error(`FK violations introduced by ${file}:`, violations);
    process.exit(1);
  }
  console.log(`applied ${file}`);
  ran++;
}

console.log(ran === 0 ? 'no migrations to apply' : `applied ${ran} migration(s)`);

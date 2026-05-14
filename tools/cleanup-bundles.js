#!/usr/bin/env node
//
// tools/cleanup-bundles.js — prune old evidence-package zips from data/bundles/
// and null out the matching t661_exports.bundle_path so the API knows to
// rebuild on demand.
//
// Usage:
//   node tools/cleanup-bundles.js
//   npm run cleanup:bundles
//
// Retention:
//   BUNDLE_RETENTION_DAYS (default 90). Bundles whose mtime is older than the
//   cutoff are removed.
//
// Why null the column:
//   GET /api/exports/:id/evidence-package returns 404 when the bundle file is
//   missing on disk. Nulling bundle_path makes the API treat the row as
//   "never built" so a POST will recreate it — the underlying export data
//   (totals_json, project_revisions_json, evidence_manifest_json) is intact.

import path from 'node:path';
import fs from 'node:fs';
import { db } from '../src/db/index.js';
import { config, ROOT_DIR } from '../src/config.js';

const RETENTION_DAYS = Number(process.env.BUNDLE_RETENTION_DAYS || 90);
const BUNDLES_DIR = path.resolve(ROOT_DIR, 'data', 'bundles');

function main() {
  if (!fs.existsSync(BUNDLES_DIR)) {
    console.log(`no bundles dir at ${BUNDLES_DIR} — nothing to do`);
    return;
  }

  const cutoffMs = Date.now() - RETENTION_DAYS * 86_400_000;
  let removedFiles = 0;
  let nulledRows = 0;
  let skippedFresh = 0;

  for (const name of fs.readdirSync(BUNDLES_DIR)) {
    if (!name.endsWith('.zip')) continue;
    const full = path.join(BUNDLES_DIR, name);
    let stat;
    try { stat = fs.statSync(full); }
    catch { continue; }
    if (stat.mtimeMs >= cutoffMs) {
      skippedFresh += 1;
      continue;
    }

    // Null out any t661_exports row pointing at this path BEFORE unlinking,
    // so a crash between the two leaves the DB pointing at a missing file
    // (already a 404 case) rather than a dangling reference that won't get
    // cleaned on a re-run.
    const info = db.prepare(
      `UPDATE t661_exports SET bundle_path = NULL WHERE bundle_path = ?`
    ).run(full);
    nulledRows += info.changes;

    try {
      fs.unlinkSync(full);
      removedFiles += 1;
    } catch (e) {
      console.warn(`warn: could not unlink ${full}: ${e.message}`);
    }
  }

  // Also catch orphan rows whose bundle_path points at a file that is already
  // gone (e.g. an operator deleted the file by hand). These should be nulled
  // so the API stops returning 404 for them.
  const orphanRows = db.prepare(
    `SELECT id, bundle_path FROM t661_exports WHERE bundle_path IS NOT NULL`
  ).all();
  let nulledOrphans = 0;
  for (const row of orphanRows) {
    if (!fs.existsSync(row.bundle_path)) {
      db.prepare(`UPDATE t661_exports SET bundle_path = NULL WHERE id = ?`).run(row.id);
      nulledOrphans += 1;
    }
  }

  console.log(`removed ${removedFiles} bundle file(s) older than ${RETENTION_DAYS} days`);
  console.log(`nulled  ${nulledRows} t661_exports.bundle_path reference(s) (pruned)`);
  if (nulledOrphans > 0) {
    console.log(`nulled  ${nulledOrphans} t661_exports.bundle_path orphan(s) (file already missing)`);
  }
  console.log(`kept    ${skippedFresh} fresh bundle(s)`);
}

main();

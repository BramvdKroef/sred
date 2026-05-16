// Migration 016 (projects.hypothesis + projects.uncertainty_identified_at)
// schema tests. Closes SRED_DOMAIN_REVIEW.md P3 (F3).
//
// Two audit-defensibility fields are added to `projects` (and mirrored on
// `project_revisions` so each snapshot is self-contained):
//
//   - hypothesis: TEXT NULL. The working hypothesis the team tested. CRA's
//     five-question framework expects this distinct from `uncertainties`
//     (which captures the open question).
//   - uncertainty_identified_at: TEXT NULL, ISO date. When the team
//     identified the technological uncertainty. Helps prove contemporaneity.
//     Same `GLOB '????-??-??'` shape used by labour_entries.work_date,
//     expenses.expense_date, evidence_items.evidence_date.
//
// Schema invariants verified here:
//   - Both columns land on `projects` AND on `project_revisions`.
//   - Both columns are nullable (legacy rows pre-migration carry NULL).
//   - The CHECK on `uncertainty_identified_at` accepts NULL, accepts a
//     well-formed ISO date, and rejects a malformed value.
//   - A `hypothesis` insert round-trips its text verbatim.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertProject,
} from '../helpers/db.js';

let ctx;
let claimantId;
let adminId;

before(async () => {
  ctx = await setupTempDb();
  adminId = insertUser(ctx.db, { role: 'admin', email: 'admin-016@example.com' });
  claimantId = insertClaimant(ctx.db);
});

after(() => {
  teardownTempDb(ctx);
});

test('migration 016 is applied', () => {
  const { db } = ctx;
  const row = db.prepare(`SELECT filename FROM _migrations WHERE filename = ?`)
    .get('016_project_audit_fields.sql');
  assert.ok(row, 'migration 016 should be recorded as applied');
});

test('projects has hypothesis + uncertainty_identified_at columns', () => {
  const { db } = ctx;
  const cols = db.prepare(`PRAGMA table_info(projects)`).all().map(r => r.name);
  assert.ok(cols.includes('hypothesis'),
    `projects should have hypothesis; got ${cols.join(', ')}`);
  assert.ok(cols.includes('uncertainty_identified_at'),
    `projects should have uncertainty_identified_at; got ${cols.join(', ')}`);
});

test('project_revisions mirrors hypothesis + uncertainty_identified_at columns', () => {
  const { db } = ctx;
  const cols = db.prepare(`PRAGMA table_info(project_revisions)`).all().map(r => r.name);
  assert.ok(cols.includes('hypothesis'),
    `project_revisions should mirror hypothesis; got ${cols.join(', ')}`);
  assert.ok(cols.includes('uncertainty_identified_at'),
    `project_revisions should mirror uncertainty_identified_at; got ${cols.join(', ')}`);
});

test('legacy projects pre-migration carry NULL in both new columns', () => {
  // insertProject helper doesn't pass either field — that exercises the
  // "no value provided" path which must default to NULL (the columns are
  // nullable with no DEFAULT).
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'Legacy project' });
  const row = db.prepare(`SELECT hypothesis, uncertainty_identified_at FROM projects WHERE id = ?`).get(pid);
  assert.equal(row.hypothesis, null);
  assert.equal(row.uncertainty_identified_at, null);
});

test('hypothesis round-trips its text verbatim', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'Hypothesis round-trip' });
  const hyp = 'A token-bucket variant with online capacity estimation will converge under correlated churn.';
  db.prepare(`UPDATE projects SET hypothesis = ? WHERE id = ?`).run(hyp, pid);
  const row = db.prepare(`SELECT hypothesis FROM projects WHERE id = ?`).get(pid);
  assert.equal(row.hypothesis, hyp);
});

test('uncertainty_identified_at accepts well-formed ISO dates', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'ISO date OK' });
  db.prepare(`UPDATE projects SET uncertainty_identified_at = ? WHERE id = ?`)
    .run('2024-07-15', pid);
  const row = db.prepare(`SELECT uncertainty_identified_at FROM projects WHERE id = ?`).get(pid);
  assert.equal(row.uncertainty_identified_at, '2024-07-15');
});

test('uncertainty_identified_at accepts NULL (the explicit-null path)', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'ISO date null' });
  // Set then unset.
  db.prepare(`UPDATE projects SET uncertainty_identified_at = ? WHERE id = ?`)
    .run('2024-01-01', pid);
  db.prepare(`UPDATE projects SET uncertainty_identified_at = ? WHERE id = ?`)
    .run(null, pid);
  const row = db.prepare(`SELECT uncertainty_identified_at FROM projects WHERE id = ?`).get(pid);
  assert.equal(row.uncertainty_identified_at, null);
});

test('uncertainty_identified_at CHECK rejects malformed dates', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'ISO date malformed' });
  for (const bad of ['not-a-date', '2024/01/01', '24-01-01', '2024-1-1', 'today']) {
    assert.throws(
      () => db.prepare(`UPDATE projects SET uncertainty_identified_at = ? WHERE id = ?`).run(bad, pid),
      err => err && /CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/.test(String(err.message ?? err)),
      `expected CHECK violation for ${bad}`,
    );
  }
});

test('project_revisions accepts both new columns on insert', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'Revisions roundtrip' });
  const info = db.prepare(`
    INSERT INTO project_revisions
      (project_id, title, field_of_science, advancement_sought, uncertainties,
       work_performed, hypothesis, uncertainty_identified_at,
       type, manager_user_id, revised_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pid, 'Revisions roundtrip', 'cs',
    'adv text', 'unc text', 'wp text',
    'we hypothesised the streaming graph inference would converge in O(n log n)',
    '2024-03-10',
    'sred', null, adminId,
  );
  assert.equal(info.changes, 1);
  const row = db.prepare(`SELECT * FROM project_revisions WHERE id = ?`).get(info.lastInsertRowid);
  assert.equal(row.hypothesis, 'we hypothesised the streaming graph inference would converge in O(n log n)');
  assert.equal(row.uncertainty_identified_at, '2024-03-10');
});

test('project_revisions CHECK rejects malformed uncertainty_identified_at', () => {
  const { db } = ctx;
  const pid = insertProject(ctx.db, claimantId, { title: 'Revisions check' });
  assert.throws(
    () => db.prepare(`
      INSERT INTO project_revisions
        (project_id, title, field_of_science, advancement_sought, uncertainties,
         work_performed, hypothesis, uncertainty_identified_at,
         type, manager_user_id, revised_by_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pid, 'X', 'cs', null, null, null, null, 'not-a-date', 'sred', null, adminId),
    err => err && /CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/.test(String(err.message ?? err)),
  );
});

// Verifies the indexes and CHECK constraints added by migration 013.
//
// - Asserts every new index is present on the right table.
// - Inserts rows that should violate each new CHECK and expects a
//   SQLITE_CONSTRAINT_CHECK error.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTempDb,
  teardownTempDb,
  insertUser,
  insertClaimant,
  insertFiscalPeriod,
  insertUserClaimant,
  insertProject,
} from '../helpers/db.js';

let ctx;

before(async () => {
  ctx = await setupTempDb();
});

after(() => {
  teardownTempDb(ctx);
});

function indexNames(db, table) {
  return db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all().map(r => r.name);
}

test('migration 013 is applied', () => {
  const { db } = ctx;
  const row = db.prepare(`SELECT filename FROM _migrations WHERE filename = ?`)
    .get('013_perf_indexes_and_checks.sql');
  assert.ok(row, 'migration 013 should be recorded as applied');
});

test('new indexes exist on every target table', () => {
  const { db } = ctx;

  const expected = {
    compensation_rows: ['idx_comp_uc'],
    expenses:          ['idx_expense_period', 'idx_expense_project', 'idx_expense_uc'],
    evidence_items:    ['idx_evidence_project', 'idx_evidence_period',
                        'idx_evidence_labour', 'idx_evidence_expense'],
    audit_log:         ['idx_audit_entity', 'idx_audit_actor', 'idx_audit_created'],
  };

  for (const [table, names] of Object.entries(expected)) {
    const present = new Set(indexNames(db, table));
    for (const name of names) {
      assert.ok(present.has(name), `${table} should have index ${name}; got ${[...present].join(', ')}`);
    }
  }
});

// Helper: assert a `db.prepare(sql).run(...args)` throws a SQLITE_CONSTRAINT_CHECK.
function assertCheckFails(db, sql, args, label) {
  assert.throws(
    () => db.prepare(sql).run(...args),
    err => err && /CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/.test(String(err.message ?? err)),
    `${label}: expected a CHECK constraint violation`,
  );
}

test('compensation_rows rejects amount_cents <= 0', () => {
  const { db } = ctx;
  const userId = insertUser(db);
  const claimantId = insertClaimant(db);
  const ucId = insertUserClaimant(db, userId, claimantId);

  assertCheckFails(
    db,
    `INSERT INTO compensation_rows
       (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
     VALUES (?, ?, ?, ?, ?)`,
    [ucId, 'salary', 0, 2080, '2025-01-01'],
    'amount_cents = 0',
  );

  assertCheckFails(
    db,
    `INSERT INTO compensation_rows
       (user_claimant_id, comp_type, amount_cents, hours_per_year, effective_from)
     VALUES (?, ?, ?, ?, ?)`,
    [ucId, 'salary', -1, 2080, '2025-01-01'],
    'amount_cents = -1',
  );
});

test('expenses rejects amount_cents <= 0, malformed expense_date, and fx_rate <= 0', () => {
  const { db } = ctx;
  const userId = insertUser(db);
  const claimantId = insertClaimant(db);
  const periodId = insertFiscalPeriod(db, claimantId);
  const ucId = insertUserClaimant(db, userId, claimantId);
  const projectId = insertProject(db, claimantId);

  const baseSql = `
    INSERT INTO expenses
      (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
       amount_cents, currency, fx_rate, description, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  // amount_cents = 0
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, '2025-03-15', 'material', 0, 'CAD', null, 'x', 'pending'],
    'amount_cents = 0',
  );
  // amount_cents = -50
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, '2025-03-15', 'material', -50, 'CAD', null, 'x', 'pending'],
    'amount_cents = -50',
  );
  // malformed expense_date
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, '2025/03/15', 'material', 100, 'CAD', null, 'x', 'pending'],
    'expense_date with slashes',
  );
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, 'not-a-date', 'material', 100, 'CAD', null, 'x', 'pending'],
    'expense_date garbage',
  );
  // fx_rate = 0
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, '2025-03-15', 'material', 100, 'USD', 0, 'x', 'pending'],
    'fx_rate = 0',
  );
  // fx_rate = -1
  assertCheckFails(
    db, baseSql,
    [projectId, ucId, periodId, '2025-03-15', 'material', 100, 'USD', -1, 'x', 'pending'],
    'fx_rate = -1',
  );

  // Sanity check: a valid row still inserts cleanly.
  const ok = db.prepare(baseSql).run(
    projectId, ucId, periodId, '2025-03-15', 'material', 100, 'CAD', null, 'x', 'pending'
  );
  assert.equal(ok.changes, 1);
});

test('evidence_items rejects malformed evidence_date', () => {
  const { db } = ctx;
  const userId = insertUser(db);
  const claimantId = insertClaimant(db);
  const periodId = insertFiscalPeriod(db, claimantId);
  const projectId = insertProject(db, claimantId);

  const sql = `
    INSERT INTO evidence_items
      (project_id, fiscal_period_id, uploaded_by_user_id, kind, caption,
       evidence_date, note_text)
    VALUES (?, ?, ?, 'note', ?, ?, ?)
  `;

  assertCheckFails(
    db, sql,
    [projectId, periodId, userId, 'x', '2025-3-15', 'note'],
    'evidence_date too few digits',
  );
  assertCheckFails(
    db, sql,
    [projectId, periodId, userId, 'x', 'yesterday', 'note'],
    'evidence_date garbage',
  );

  // Sanity check: valid date inserts.
  const ok = db.prepare(sql).run(projectId, periodId, userId, 'x', '2025-03-15', 'note');
  assert.equal(ok.changes, 1);
});

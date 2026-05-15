// Migration 014 (expenses.overhead_subcategory + allocation_basis) tests.
//
// Schema invariants verified here:
//   - A valid overhead row with subcategory + basis inserts cleanly.
//   - A non-overhead row carrying a subcategory fails the whole-row CHECK
//     (overhead-only columns must be NULL when category != 'overhead').
//   - A non-overhead row carrying an allocation_basis likewise fails.
//   - An overhead row WITHOUT subcategory passes the schema CHECK — the
//     "must be present" rule lives in the route layer, not the column. The
//     route-level test in tests/routes/expense-overhead-fields.test.js
//     proves that path returns 400.
//   - The overhead_subcategory CHECK enum is enforced (only the 5
//     documented values are accepted).
//
// Why split this way: the schema is intentionally permissive about
// "overhead row missing subcategory" so a historical row (pre-migration)
// could be migrated in NULL and back-filled later via the admin edit form.
// The API path is strict, so freshly-submitted overhead rows must have
// both fields.

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
let projectId, ucId, periodId;

before(async () => {
  ctx = await setupTempDb();
  const userId = insertUser(ctx.db);
  const claimantId = insertClaimant(ctx.db);
  periodId = insertFiscalPeriod(ctx.db, claimantId);
  ucId = insertUserClaimant(ctx.db, userId, claimantId);
  projectId = insertProject(ctx.db, claimantId);
});

after(() => {
  teardownTempDb(ctx);
});

test('migration 014 is applied', () => {
  const { db } = ctx;
  const row = db.prepare(`SELECT filename FROM _migrations WHERE filename = ?`)
    .get('014_expense_overhead_subcategory.sql');
  assert.ok(row, 'migration 014 should be recorded as applied');
});

test('expenses has overhead_subcategory + allocation_basis columns', () => {
  const { db } = ctx;
  const cols = db.prepare(`PRAGMA table_info(expenses)`).all().map(r => r.name);
  assert.ok(cols.includes('overhead_subcategory'), `expenses should have overhead_subcategory; got ${cols.join(', ')}`);
  assert.ok(cols.includes('allocation_basis'),     `expenses should have allocation_basis; got ${cols.join(', ')}`);
});

const baseInsertSql = `
  INSERT INTO expenses
    (project_id, user_claimant_id, fiscal_period_id, expense_date, category,
     amount_cents, currency, fx_rate, description, status,
     overhead_subcategory, allocation_basis)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function assertCheckFails(db, args, label) {
  assert.throws(
    () => db.prepare(baseInsertSql).run(...args),
    err => err && /CHECK constraint failed|SQLITE_CONSTRAINT_CHECK/.test(String(err.message ?? err)),
    `${label}: expected a CHECK constraint violation`,
  );
}

test('valid overhead row with subcategory + basis inserts cleanly', () => {
  const { db } = ctx;
  const info = db.prepare(baseInsertSql).run(
    projectId, ucId, periodId, '2025-03-15', 'overhead',
    50_000, 'CAD', null, 'office rent share', 'approved',
    'rent', '30% of total floor area',
  );
  assert.equal(info.changes, 1);
  const row = db.prepare(`SELECT * FROM expenses WHERE id = ?`).get(info.lastInsertRowid);
  assert.equal(row.category, 'overhead');
  assert.equal(row.overhead_subcategory, 'rent');
  assert.equal(row.allocation_basis, '30% of total floor area');
});

test('non-overhead row carrying overhead_subcategory fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    [projectId, ucId, periodId, '2025-03-15', 'material',
     10_000, 'CAD', null, 'lab supply', 'approved',
     'rent', null],
    'material + overhead_subcategory=rent',
  );
});

test('non-overhead row carrying allocation_basis fails CHECK', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    [projectId, ucId, periodId, '2025-03-15', 'contract',
     10_000, 'CAD', null, 'contracted work', 'approved',
     null, 'some allocation note'],
    'contract + allocation_basis',
  );
});

test('overhead row WITHOUT subcategory passes schema CHECK (route enforces requiredness)', () => {
  const { db } = ctx;
  // Both null on an overhead row is valid at the schema layer — the API
  // layer rejects it with a 400. Verified in
  // tests/routes/expense-overhead-fields.test.js.
  const info = db.prepare(baseInsertSql).run(
    projectId, ucId, periodId, '2025-03-15', 'overhead',
    20_000, 'CAD', null, 'legacy overhead row', 'approved',
    null, null,
  );
  assert.equal(info.changes, 1);
});

test('overhead_subcategory CHECK rejects unknown enum values', () => {
  const { db } = ctx;
  assertCheckFails(
    db,
    [projectId, ucId, periodId, '2025-03-15', 'overhead',
     10_000, 'CAD', null, 'unknown subcat', 'approved',
     'travel', '50%'],     // 'travel' not in the documented enum
    'overhead_subcategory=travel',
  );
});
